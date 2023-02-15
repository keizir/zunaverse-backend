import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import axios from 'axios';
import Web3 from 'web3';

import MediaAbi from '../indexer/abis/Zuna.json';
import MarketAbi from '../indexer/abis/Market.json';
import { Activity } from 'src/database/entities/Activity';
import { Nft } from 'src/database/entities/Nft';
import { Ask } from 'src/database/entities/Ask';
import { Currency } from 'src/database/entities/Currency';
import { fromWei } from 'src/shared/utils/currency';
import { Transaction } from 'src/database/entities/Transaction';
import { User } from 'src/database/entities/User';
import { Notification } from 'src/database/entities/Notification';
import { Bid } from 'src/database/entities/Bid';
import { ACTIVITY_EVENTS, BURN_ADDRESSES } from 'src/consts';
import { Collection } from 'src/database/entities/Collection';

@Injectable()
export class StreamService {
  logger = new Logger(StreamService.name);

  async handleOffer(
    tokenId: string,
    tokenAddress: string,
    txHash: string,
    logIndex: number,
    offer: any,
    seller: string,
    buyer: string,
    buying: boolean,
  ) {
    this.logger.log(`handleOffer: ${tokenAddress}: ${tokenId}`);

    tokenAddress = tokenAddress.toLowerCase();

    const [nft, activity] = await Promise.all([
      Nft.createQueryBuilder('n')
        .where('n.tokenId = :tokenId AND n.tokenAddress = :tokenAddress', {
          tokenId,
          tokenAddress,
        })
        .leftJoinAndMapOne('n.owner', User, 'u', 'n.ownerId = u.id')
        .leftJoinAndMapOne(
          'n.collection',
          Collection,
          'c',
          'n.collectionId = c.id',
        )
        .getOne(),
      Activity.findOne({
        where: {
          txHash,
          logIndex: logIndex - 1,
        },
      }),
    ]);

    if (!nft) {
      throw new UnprocessableEntityException(
        `Nft does not exist for tokenId: ${tokenId}`,
      );
    }
    if (!activity) {
      throw new UnprocessableEntityException(`Transfer activity missing`);
    }

    const erc20Address = offer.erc20Address || offer[offer.length - 4];
    const amount = offer.amount || offer[offer.length - 3];

    const currency = await Currency.findOneBy({
      address: erc20Address.toLowerCase(),
    });
    activity.event = 'Sale';
    activity.amount = fromWei(Web3.utils.toBN(amount), currency.decimals);
    activity.currency = erc20Address;

    await activity.save();

    const usd = +currency.usd * +activity.amount;

    const transaction = await Transaction.create({
      amount: +activity.amount,
      currency: activity.currency,
      txHash: activity.txHash,
      collectionId: nft.collectionId,
      buyer,
      seller,
      usd,
      ...nft.tokenIdentity,
    }).save();

    const [sellerUser, buyerUser] = await Promise.all([
      User.findByPubKey(seller),
      User.findByPubKey(buyer),
    ]);

    await Notification.create({
      user: buying ? sellerUser : buyerUser,
      text: buying
        ? 'One of your nfts has been sold.'
        : 'One of your offers has been accepted.',
      metadata: {
        activityId: activity.id,
        from: (buying ? buyer : seller).toLowerCase(),
        offer: {
          amount: activity.amount,
          currency: activity.currency,
        },
        txHash,
      },
      ...nft.tokenIdentity,
    }).save();

    await Bid.delete({
      bidder: (buyer as string).toLowerCase(),
      ...nft.tokenIdentity,
    });

    if (nft.collection) {
      nft.collection.totalVolume += transaction.usd;
      await nft.collection.save();
    }
    this.logger.log(`handleOffer Success: ${tokenAddress}: ${tokenId}`);
  }

  async handlePriceRemoval(tokenId: string, txHash: string) {
    this.logger.log(`handlePriceRemoval: ${tokenId}`);

    const nft = await Nft.findOne({
      where: {
        tokenId,
        tokenAddress: process.env.MEDIA_CONTRACT.toLowerCase(),
      },
      relations: ['owner'],
    });

    if (!nft) {
      throw new UnprocessableEntityException('The nft does not exist');
    }
    const ask = await Ask.findOneBy(nft.tokenIdentity);

    if (ask && Object.keys(ask.typedData).length > 0) {
      this.logger.log(`handlePriceRemoval Success: ${tokenId}`);
      return;
    }
    nft.currentAskId = null;
    nft.onSale = false;
    await Ask.delete(nft.tokenIdentity);
    await nft.save();

    const activity = new Activity();
    activity.createdAt = Date.now().toString();
    activity.event = ACTIVITY_EVENTS.SALES.PRICE_REMOVE;
    activity.userAddress = nft.owner.pubKey;
    activity.tokenAddress = nft.tokenAddress;
    activity.tokenId = tokenId;
    activity.collectionId = nft.collectionId;
    activity.txHash = txHash;
    await activity.save();

    const collection = await Collection.findOneBy({ id: nft.collectionId });

    await collection.calculateFloorPrice();

    this.logger.log(`handlePriceRemoval Success: ${tokenId}`);
  }

  async handleBulkPriceSet(tokenIds: string[]) {
    this.logger.log(`handleBulkPriceSet: ${tokenIds.join(', ')}`);

    const web3 = new Web3(
      new Web3.providers.HttpProvider(process.env.HTTPS_RPC_URL),
    );
    const contract = new web3.eth.Contract(
      MarketAbi as any,
      process.env.MARKET_CONTRACT,
    );

    let collection: Collection;

    for (const tokenId of tokenIds) {
      const offer = await contract.methods.prices(tokenId).call();

      if (+offer.amount === 0) {
        continue;
      }
      const tokenIdentity = {
        tokenId,
        tokenAddress: process.env.MEDIA_CONTRACT.toLowerCase(),
      };

      const nft = await Nft.findOne({
        where: tokenIdentity,
        relations: ['owner'],
      });

      if (!nft) {
        throw new UnprocessableEntityException(
          `Nft does not exist for ${tokenId}`,
        );
      }

      const currency = await Currency.findOneBy({
        address: offer.erc20Address.toLowerCase(),
      });

      let ask = await Ask.findOneBy(tokenIdentity);

      if (!ask) {
        ask = Ask.create({ ...tokenIdentity });
      }
      ask.currency = offer.erc20Address;
      ask.amount = fromWei(offer.amount, currency.decimals);
      ask.typedData = {};
      ask.owner = nft.owner.pubKey;
      ask.owner = nft.owner.pubKey;
      ask.collectionId = nft.collectionId;

      await ask.save();

      nft.currentAskId = ask.id;

      await nft.save();

      if (!collection) {
        collection = await Collection.findOneBy({ id: nft.collectionId });
      }
    }

    if (collection) {
      await collection.calculateFloorPrice();
    }
    this.logger.log(`handleBulkPriceSet Success: ${tokenIds.join(', ')}`);
  }

  async handleTransfer(
    tokenId: string,
    tokenAddress: string,
    transactionHash: string,
    from: string,
    to: string,
    logIndex: number,
    timestamp: string,
  ) {
    this.logger.log(`handleTransfer: ${tokenAddress}: ${tokenId}`);

    const nft = await Nft.findOneBy({ tokenId, tokenAddress });
    const isZunaNFT =
      tokenAddress.toLowerCase() === process.env.MEDIA_CONTRACT.toLowerCase();

    if (!nft) {
      if (!isZunaNFT || BURN_ADDRESSES.includes(to)) {
        return;
      }
      const web3 = new Web3(
        new Web3.providers.HttpProvider(process.env.HTTPS_RPC_URL),
      );
      const contract = new web3.eth.Contract(
        MediaAbi as any,
        process.env.MEDIA_CONTRACT,
      );

      const [tokenUri, collectionId, tokenInfo] = await Promise.all([
        contract.methods.tokenURI(tokenId).call(),
        contract.methods.collectionIds(tokenId).call(),
        contract.methods.getTokenInfo(tokenId).call(),
      ]);
      const royalties = tokenInfo[1];

      if (!tokenUri) {
        this.logger.error(`None existing NFT`);
        throw new UnprocessableEntityException('Nft doesnt exist');
      }
      const url = tokenUri.replace('ipfs://', process.env.PINATA_GATE_WAY);
      const { data: metadata } = await axios.get(url);

      const { name, description, category, image, properties } = metadata;

      const owner = await User.findOrCreate(to);

      const nft = Nft.create({
        name,
        description,
        category,
        image,
        properties,
        tokenUri,
        minted: true,
        owner,
        creator: owner,
        onSale: true,
        tokenId,
        tokenAddress,
        collectionId: +collectionId,
        royaltyFee: +royalties,
        txHash: transactionHash,
        mintedAt: `${+timestamp * 1000}`,
      });
      await nft.resizeNftImage();
      await nft.save();

      const activity = Activity.create({
        txHash: transactionHash,
        logIndex,
        event: ACTIVITY_EVENTS.MINT,
        userAddress: to,
        createdAt: `${+timestamp * 1000}`,
        collectionId: nft.collectionId,
        ...nft.tokenIdentity,
      });
      await activity.save();

      nft.collection = await Collection.findOneBy({ id: nft.collectionId });

      if (nft.collection) {
        await nft.collection.calculateMetrics();
        await nft.updateCollectionProperty();
      }
      this.logger.log(`handleTransfer Success: ${tokenAddress}: ${tokenId}`);
      return;
    }

    if (BURN_ADDRESSES.includes(to)) {
      await nft.burn();
      this.logger.log(`handleTransfer Success: ${tokenAddress}: ${tokenId}`);
      return;
    }

    const fromUser = BURN_ADDRESSES.includes(from)
      ? null
      : await User.findOrCreate(from);
    const toUser = await User.findOrCreate(to);

    if (!nft.minted) {
      nft.minted = true;
      nft.txHash = transactionHash;
    }
    nft.owner = toUser;
    nft.currentAskId = null;

    await Ask.delete(nft.tokenIdentity);

    if (fromUser) {
      const activity = Activity.create({
        txHash: transactionHash,
        logIndex,
        event: ACTIVITY_EVENTS.TRANSFERS,
        userAddress: from,
        receiver: to,
        createdAt: `${+timestamp * 1000}`,
        ...nft.tokenIdentity,
      });

      if (nft.collectionId) {
        activity.collectionId = nft.collectionId;
      }

      await Promise.all([
        Bid.delete({ bidder: toUser.pubKey, ...nft.tokenIdentity }),
        activity.save(),
      ]);
    }
    await nft.save();

    if (nft.collectionId) {
      await this.calculateCollection(nft.collectionId);
    }

    this.logger.log(`handleTransfer Success: ${tokenAddress}: ${tokenId}`);
  }

  async calculateCollection(collectionId: number) {
    const collection = await Collection.findOneBy({ id: collectionId });

    if (!collection) {
      throw new Error(`Collection ${collectionId} does not exist`);
    }
    await collection.calculateMetrics();
    await collection.calculateFloorPrice();
  }
}
