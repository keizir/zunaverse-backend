import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { In } from 'typeorm';

import { ACTIVITY_EVENTS, PAGINATION } from 'src/consts';
import { Activity } from 'src/database/entities/Activity';
import { Ask } from 'src/database/entities/Ask';
import { Bid } from 'src/database/entities/Bid';
import { Collection } from 'src/database/entities/Collection';
import { Favorite } from 'src/database/entities/Favorite';
import { Nft } from 'src/database/entities/Nft';
import { Notification } from 'src/database/entities/Notification';
import { User } from 'src/database/entities/User';
import { Currency } from 'src/database/entities/Currency';
import { CurrentUser } from 'src/shared/decorators/current-user.decorator';
import { AuthGuard } from 'src/shared/guards/auth.guard';
import { ShortLink } from 'src/database/entities/ShortLink';
import { CreateNftDto, CreateTempNftDto } from './nft.dto';
import { TempNft } from 'src/database/entities/TempNft';
import { buildPagination, checkRevealDate } from 'src/shared/utils/helper';
import { Showcase } from 'src/database/entities/Showcase';
import { selectNfts } from 'src/database/query-helper';

@Controller('nft')
export class NftController {
  @Post('temp')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async createTempNft(
    @CurrentUser() user: User,
    @Body() body: CreateTempNftDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const {
      name,
      description,
      royaltyFee,
      collectionId,
      tokenId,
      onSale,
      properties,
    } = body;

    let category = body.category;

    if (collectionId) {
      const collection = await Collection.findOneBy({ id: +collectionId });
      category = collection.category;

      if (!collection) {
        throw new BadRequestException('Invalid collection Id');
      }
    }

    const tempNft = await TempNft.createTempNft(
      tokenId,
      name,
      description,
      category,
      JSON.parse(properties),
      +royaltyFee,
      file.path,
      user.id,
      null,
      null,
      null,
      +collectionId || null,
      null,
      onSale === 'true',
    );

    if (!tempNft.tokenUri) {
      await tempNft.pin();
    }
    return { tokenId, tokenUri: tempNft.tokenUri, id: tempNft.id };
  }

  @Post()
  @UseGuards(AuthGuard)
  async createNFT(@CurrentUser() user: User, @Body() body: CreateNftDto) {
    const { signature, tokenId, tempNftId } = body;

    if (!signature) {
      throw new BadRequestException('Need to sign voucher');
    }
    const tempNft = await TempNft.findOneBy({
      tokenId,
      id: tempNftId,
    });

    if (!tempNft) {
      throw new UnprocessableEntityException('Temp NFT does not exist');
    }

    if (tempNft.userId !== user.id) {
      throw new BadRequestException('Only owner can mint');
    }
    tempNft.signature = signature;
    const nft = await tempNft.saveAsNft(false, true);

    if (nft.collectionId) {
      const collection = await Collection.findOneBy({ id: nft.collectionId });
      await collection.calculateMetrics();
      await nft.updateCollectionProperty();
    }
    const acitivity = Activity.create({
      userAddress: user.pubKey,
      event: ACTIVITY_EVENTS.MINT,
      createdAt: `${Date.now()}`,
      tokenId: nft.tokenId,
      tokenAddress: nft.tokenAddress,
      collectionId: nft.collectionId,
    });
    await acitivity.save();

    return nft;
  }

  @Get('filter')
  async filterNFTs(@CurrentUser() user: User, @Query() query: any) {
    const {
      search,
      categories,
      saleType,
      userAddress,
      creatorAddress,
      category,
      collectionId,
      properties,
      size,
      currency,
      orderBy,
      order,
      page,
      showcase,
    } = query;

    let qb = selectNfts<Nft>(Nft.createQueryBuilder('n'), user);

    if (showcase) {
      qb.leftJoinAndMapOne('n.showcase', Showcase, 's', 's.nftId = n.id');
    }

    if (userAddress) {
      qb = qb.where('u.pubKey = :userAddress', {
        userAddress: userAddress.toLowerCase(),
      });
    }

    if (creatorAddress) {
      const creator = await User.findByPubKey(creatorAddress);

      if (creator) {
        qb = qb.andWhere('n.creatorId = :creatorId', {
          creatorId: creator.id,
        });
      }
    }

    if (collectionId) {
      qb = qb.andWhere('c.id = :collectionId', {
        collectionId: +collectionId,
      });
    }

    if (categories) {
      const c = categories.split(',');

      if (c.length) {
        qb = qb.andWhere('n.category IN (:...categories)', {
          categories: c,
        });
      }
    }

    if (category) {
      qb = qb.andWhere('n.category = :category', {
        category,
      });
    }

    if (search) {
      qb = qb.andWhere(
        `(n.name ILIKE '%${search}%' OR n.description ILIKE '%${search}%')`,
      );
    }

    if (saleType) {
      if (saleType === 'Buy Now') {
        qb = qb.andWhere('n.currentAskId IS NOT NULL');
      } else if (saleType === 'Open to bids') {
        qb = qb.andWhere('n.onSale = true');
      } else if (saleType === 'Not for sale') {
        qb = qb.andWhere('(n.onSale = false AND n.currentAskId IS NULL)');
      }
    }

    if (currency) {
      const currencies = (
        await Currency.findBy({
          symbol: In(currency.split(',')),
        })
      ).map((c) => c.address);
      qb.andWhere('a.currency IN (:...currencies)', { currencies });
    }

    if (properties) {
      const propertiesQuery = properties
        .split(';')
        .map((p) => {
          const [name, value] = p.split(':');
          const property = {
            name,
            value: value.split(','),
          };
          return property.value
            .map((v) => `(p.name = '${name}' AND p.value = '${v}')`)
            .join(' OR ');
        })
        .join(' OR ');

      qb = qb.andWhere(`
        EXISTS (
          SELECT
            *
          FROM
            JSON_TO_RECORDSET(n.properties) as p(name text, value text)
          WHERE
            ${propertiesQuery}
        )
      `);
    }

    if (orderBy === 'price') {
      qb.addSelect(
        (sub) =>
          sub
            .select('cu.usd * CAST(a.amount AS DECIMAL)', 'price')
            .from(Currency, 'cu')
            .where('a.currency = cu.address'),
        'price',
      ).orderBy('price', order || 'DESC', 'NULLS LAST');
    } else if (orderBy === 'createdAt' || !orderBy) {
      qb.orderBy('n.createdAt', order || 'DESC');
    }

    const total = await qb.getCount();
    const currentPage = +(page || 1);

    const { raw, entities } = await qb
      .skip((currentPage - 1) * PAGINATION)
      .take(size && size < 50 ? size : PAGINATION)
      .getRawAndEntities();

    const data = entities.map((e, index) => {
      e.favorites = +raw[index].favorites;
      e.favorited = !!+raw[index].favorited;

      return checkRevealDate(e);
    });

    return { data, pagination: buildPagination(total, currentPage) };
  }

  @Post(':tokenAddress/:tokenId/favorite')
  @UseGuards(AuthGuard)
  async favorite(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @CurrentUser() user: User,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const favorite = await Favorite.findOneBy({
      tokenId,
      tokenAddress,
      userAddress: user.pubKey,
    });

    if (favorite) {
      await favorite.remove();
    } else {
      let nft = await Nft.findOne({
        where: { tokenId, tokenAddress },
        relations: ['owner'],
      });

      if (!nft) {
        nft = await Nft.createFromMoralis(tokenAddress, tokenId);
      }

      if (!nft) {
        throw new UnprocessableEntityException('The nft does not exist');
      }

      await Favorite.create({
        tokenId,
        tokenAddress,
        userAddress: user.pubKey,
      }).save();

      const activity = Activity.create({
        tokenId,
        tokenAddress,
        event: ACTIVITY_EVENTS.LIKES,
        createdAt: Date.now().toString(),
        userAddress: user.pubKey,
        receiver: nft.owner.pubKey,
        collectionId: nft ? nft.collectionId : null,
      });
      await activity.save();

      if (user.pubKey !== nft.owner.pubKey) {
        const notification = Notification.create({
          tokenId,
          tokenAddress,
          user: nft.owner,
          text: 'Someone favorited your nft',
          metadata: {
            from: user.pubKey,
          },
        });
        await notification.save();
      }
    }

    return { success: true };
  }

  @Post(':tokenAddress/:tokenId/collection')
  @UseGuards(AuthGuard)
  async addCollection(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @CurrentUser() user: User,
    @Body() body: any,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const { collectionId } = body;

    const nft = await Nft.findOneBy({ tokenAddress, tokenId });

    if (!nft) {
      throw new UnprocessableEntityException('Nft not found');
    }

    const collection = await Collection.findOne({
      where: { id: +collectionId },
      relations: ['owner'],
    });

    if (!collection) {
      throw new UnprocessableEntityException('Collection not found');
    }

    if (collection.owner.id !== user.id) {
      throw new BadRequestException('User is not the owner of the collection');
    }
    nft.collection = collection;
    await nft.save();

    return { success: true };
  }

  @Get(':tokenAddress/:tokenId')
  async getOneNft(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @CurrentUser() user: User,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const nft =
      (await Nft.createQueryBuilder('Nfts')
        .where(
          'Nfts.tokenAddress = :tokenAddress AND Nfts.tokenId = :tokenId',
          {
            tokenAddress,
            tokenId,
          },
        )
        .leftJoinAndMapOne(
          'Nfts.owner',
          User,
          'Users',
          'Nfts.ownerId = Users.id',
        )
        .leftJoinAndMapOne(
          'Nfts.creator',
          User,
          'Users2',
          'Nfts.creatorId = Users2.id',
        )
        .leftJoinAndMapOne(
          'Nfts.currentAsk',
          Ask,
          'Asks',
          'Asks.id = Nfts.currentAskId',
        )
        .leftJoinAndMapOne(
          'Nfts.collection',
          Collection,
          'c',
          'c.id = Nfts.collectionId',
        )
        .innerJoinAndMapOne(
          'Nfts.shortLink',
          ShortLink,
          'sl',
          'sl.tokenAddress = Nfts.tokenAddress AND sl.tokenId = Nfts.tokenId',
        )
        .getOne()) || (await Nft.getNftFromMoralis(tokenAddress, tokenId));

    if (!nft) {
      throw new UnprocessableEntityException('The nft does not exist');
    }
    nft.owner = await User.findOrCreate(nft.owner.pubKey);

    const favorites = await Favorite.count({
      where: {
        tokenId,
        tokenAddress,
      },
    });
    nft.favorites = favorites;
    nft.favorited = user
      ? !!(await Favorite.findOne({
          where: { tokenId, tokenAddress, userAddress: user.pubKey },
        }))
      : false;

    nft.image && (nft.image = nft.fixIpfsUrl());

    return checkRevealDate(nft);
  }

  @Get(':tokenAddress/:tokenId/activities')
  async getNftActivities(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @Query() query: any,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const { offset } = query;

    const activities = await Activity.createQueryBuilder('a')
      .where('a.tokenId = :tokenId AND a.tokenAddress = :tokenAddress', {
        tokenId,
        tokenAddress,
      })
      .leftJoinAndMapOne('a.receiver', User, 'ur', 'ur.pubKey = a.receiver')
      .leftJoinAndMapOne('a.user', User, 'u', 'u.pubKey = a.userAddress')
      .orderBy('a.createdAt', 'DESC')
      .skip(+offset || 0)
      .take(PAGINATION)
      .getMany();

    return activities;
  }

  @Get(':tokenAddress/:tokenId/bids')
  async getNftBids(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @Query() query: any,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const { offset } = query;

    const bids = await Bid.createQueryBuilder('Bids')
      .leftJoinAndMapOne(
        'Bids.bidder',
        User,
        'Users',
        'Users.pubKey = Bids.bidder',
      )
      .where('Bids.tokenId = :tokenId AND Bids.tokenAddress = :tokenAddress', {
        tokenId,
        tokenAddress,
      })
      .orderBy('Bids.createdAt', 'DESC')
      .offset(+offset || 0)
      .take(PAGINATION)
      .getMany();

    return bids;
  }

  @Post(':tokenAddress/:tokenId/bids')
  @UseGuards(AuthGuard)
  async createBid(
    @CurrentUser() user: User,
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @Body() body: any,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    let nft = await Nft.findOne({
      where: { tokenAddress, tokenId },
      relations: ['owner'],
    });

    if (!nft) {
      nft = await Nft.createFromMoralis(tokenAddress, tokenId);
    }

    if (!nft) {
      throw new UnprocessableEntityException('The nft does not exist');
    }

    if (nft.owner.pubKey === user.pubKey) {
      throw new ForbiddenException('Cannot bid on your own nft');
    }

    if (!nft.onSale) {
      throw new ForbiddenException('NFT is not listed for sale');
    }

    const bid = Bid.create({
      ...body,
      ...nft.tokenIdentity,
      bidder: user.pubKey,
    }) as Bid;

    await bid.save();

    const activity = Activity.create({
      amount: bid.amount,
      currency: bid.currency,
      createdAt: Date.now().toString(),
      event: ACTIVITY_EVENTS.BIDS.NEW_BID,
      userAddress: user.pubKey,
      receiver: nft.owner.pubKey,
      collectionId: nft.collectionId,
      ...nft.tokenIdentity,
    });
    await activity.save();

    const notification = Notification.create({
      text: 'New bid on your NFT',
      user: nft.owner,
      metadata: {
        activityId: activity.id,
        offer: {
          amount: bid.amount,
          currency: bid.currency,
        },
        from: user.pubKey,
      },
      ...nft.tokenIdentity,
    });
    await notification.save();

    await nft.setHighestBidId();

    return { success: true };
  }

  @Delete(':tokenAddress/:tokenId/sale')
  @UseGuards(AuthGuard)
  async removeFromSale(
    @CurrentUser() user: User,
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const nft = await Nft.findOne({
      where: { tokenAddress, tokenId },
      relations: ['owner'],
    });

    if (!nft) {
      throw new UnprocessableEntityException('The nft does not exist');
    }

    if (nft.owner.pubKey !== user.pubKey) {
      throw new ForbiddenException('Not the nft owner');
    }

    nft.onSale = false;
    nft.highestBidId = null;

    await Bid.delete({ tokenAddress, tokenId });
    await nft.save();

    const activity = new Activity();
    activity.createdAt = Date.now().toString();
    activity.event = ACTIVITY_EVENTS.SALES.CANCEL;
    activity.userAddress = user.pubKey;
    activity.tokenId = tokenId;
    activity.tokenAddress = tokenAddress;
    activity.collectionId = nft.collectionId;
    await activity.save();

    return { success: true };
  }

  @Post(':tokenAddress/:tokenId/sale')
  @UseGuards(AuthGuard)
  async updateSale(
    @CurrentUser() user: User,
    @Body() body: any,
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    if (body.instantSale) {
      if (!body.typedData || !body.typedData.signature) {
        throw new BadRequestException('Signature is required');
      }

      if (!body.price || !body.price.amount || !body.price.currency) {
        throw new BadRequestException('Price is required');
      }
    }
    const nft =
      (await Nft.findOne({
        where: { tokenAddress, tokenId },
        relations: ['owner'],
      })) || (await Nft.createFromMoralis(tokenAddress, tokenId));

    if (!nft) {
      throw new UnprocessableEntityException('The nft does not exist');
    }

    const collection = await Collection.findOneBy({ id: nft.collectionId });

    if (nft.owner.pubKey !== user.pubKey) {
      throw new ForbiddenException('Not the nft owner');
    }

    if (nft.onSale !== body.onSale) {
      nft.onSale = !!body.onSale;

      const activity = new Activity();
      activity.createdAt = Date.now().toString();
      activity.event = nft.onSale
        ? ACTIVITY_EVENTS.SALES.PUT
        : ACTIVITY_EVENTS.SALES.CANCEL;
      activity.userAddress = user.pubKey;
      activity.tokenAddress = tokenAddress;
      activity.tokenId = tokenId;
      activity.collectionId = nft.collectionId;
      await activity.save();
    }

    if (body.instantSale) {
      let ask = await Ask.findOneBy(nft.tokenIdentity);

      if (!ask) {
        ask = Ask.create({
          ...nft.tokenIdentity,
        });
      }
      ask.amount = body.price.amount;
      ask.currency = body.price.currency;
      ask.typedData = body.typedData;
      ask.owner = user.pubKey;
      ask.collectionId = nft.collectionId;
      await ask.save();
      nft.currentAskId = ask.id;

      const activity = new Activity();
      activity.amount = ask.amount;
      activity.currency = ask.currency;
      activity.createdAt = Date.now().toString();
      activity.event = ACTIVITY_EVENTS.SALES.PRICE_SET;
      activity.userAddress = user.pubKey;
      activity.tokenAddress = tokenAddress;
      activity.tokenId = tokenId;
      activity.collectionId = nft.collectionId;
      await activity.save();
    } else {
      if (nft.currentAskId) {
        nft.currentAskId = null;
        await Ask.delete({ tokenAddress, tokenId });
        const activity = new Activity();
        activity.createdAt = Date.now().toString();
        activity.event = ACTIVITY_EVENTS.SALES.PRICE_REMOVE;
        activity.userAddress = user.pubKey;
        activity.tokenAddress = tokenAddress;
        activity.tokenId = tokenId;
        activity.collectionId = nft.collectionId;
        await activity.save();
      }
    }
    await nft.save();

    if (collection) {
      await collection.calculateFloorPrice();
    }

    return { success: true };
  }

  @Delete(':tokenAddress/:tokenId')
  @UseGuards(AuthGuard)
  async burnNFT(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @CurrentUser() user: User,
  ) {
    const nft = await Nft.findOneBy({ tokenAddress, tokenId });

    if (!nft) {
      throw new UnprocessableEntityException('The nft does not exist');
    }

    if (nft.minted) {
      throw new BadRequestException('The nft is minted on-chain');
    }

    if (user.id !== nft.ownerId) {
      throw new ForbiddenException('Not the nft owner');
    }

    await nft.burn();

    return { success: true };
  }

  @Post(':tokenAddress/:tokenId/short-link')
  async generateShortLink(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const nft = await Nft.findOneBy({
      tokenAddress,
      tokenId,
    });

    if (!nft) {
      throw new UnprocessableEntityException('Nft not found');
    }
    const shortLink = await ShortLink.findOneBy({ tokenAddress, tokenId });

    if (!shortLink) {
      return await nft.saveShortLink();
    }
    return shortLink;
  }

  @Post(':tokenAddress/:tokenId/showcase')
  @UseGuards(AuthGuard)
  async featureNft(
    @Param('tokenAddress') tokenAddress: string,
    @Param('tokenId') tokenId: string,
    @CurrentUser() user: User,
  ) {
    tokenAddress = tokenAddress.toLowerCase();

    const nft = await Nft.findOneBy({
      tokenId,
      tokenAddress,
    });

    if (!nft) {
      throw new UnprocessableEntityException('Nft not found');
    }

    if (nft.ownerId !== user.id) {
      throw new BadRequestException('Not the nft owner');
    }
    let showcase = await Showcase.findOneBy({ nftId: nft.id });

    if (!showcase) {
      const lastShowcase = await Showcase.findOne({
        where: {
          userId: user.id,
        },
        order: {
          order: 'DESC',
        },
      });
      showcase = await Showcase.create({
        userId: user.id,
        nftId: nft.id,
        order: lastShowcase ? lastShowcase.order + 1 : 1,
      }).save();
    } else {
      await showcase.remove();
    }

    return { success: true };
  }
}
