import { BeforeInsert, Column, Entity, Index, ManyToOne } from 'typeorm';
import sharp from 'sharp';
import fs from 'fs';
import { Activity } from './Activity';
import { Ask } from './Ask';
import { Bid } from './Bid';
import { Collection } from './Collection';
import { Favorite } from './Favorite';
import { Notification } from './Notification';
import { PrimaryEntity } from './primary-entity';
import { User } from './User';
import { downloadFile } from 'src/shared/utils/download-file';
import { uploadNftImageCloudinary } from 'src/shared/utils/cloudinary';

@Entity('Nfts')
export class Nft extends PrimaryEntity {
  @Column()
  @Index({ unique: true })
  tokenId: string;

  @Column()
  tokenUri: string;

  @Column()
  name: string;

  @Column()
  description: string;

  @Column({ nullable: true })
  category: string;

  @Column({ type: 'json' })
  properties: any[];

  @Column()
  royaltyFee: number;

  @Column({ nullable: true })
  thumbnail: string;

  @Column()
  image: string;

  @ManyToOne(() => User)
  owner: User;

  @Column()
  ownerId: number;

  @ManyToOne(() => User)
  creator: User;

  @Column({ nullable: true })
  collectionId: number;

  @Column({ nullable: true })
  currentAskId: number;

  @Column({ nullable: true })
  signature: string;

  @Column()
  onSale: boolean;

  @Column()
  minted: boolean;

  @Column({ nullable: true })
  mintedAt: number;

  @Column({ nullable: true })
  txHash: string;

  favorited: boolean;
  favorites: number;
  collection: Collection;

  async burn() {
    await Bid.delete({ nftId: this.id });
    await Activity.delete({ nft: this.id });
    await Ask.delete({ nftId: this.id });
    await Favorite.delete({ nftId: this.id });
    await Notification.delete({ nftId: this.id });

    if (this.collectionId) {
      const collection = await Collection.findOneBy({
        id: this.collectionId,
      });
      await collection.calculateMetrics();
      await collection.calculateFloorPrice();
    }
    await this.remove();
  }

  @BeforeInsert()
  fixTokenId() {
    const withoutPrefix = this.tokenId.slice(2);

    let endZero = 0;

    while (withoutPrefix[endZero] === '0') {
      endZero += 1;
    }

    if (endZero !== 0) {
      this.tokenId = '0x' + withoutPrefix.slice(endZero);
    }
  }

  async resizeNftImage() {
    const imageUrl = this.image.replace('ipfs://', process.env.PINATA_GATE_WAY);
    let downloadPath = `${process.env.UPLOAD_FOLDER}/${this.tokenId}`;
    await downloadFile(imageUrl, downloadPath);
    const file = fs.statSync(downloadPath);

    if (file.size > 20971520) {
      const outputpath = `${process.env.UPLOAD_FOLDER}/${this.tokenId}_resized`;
      await sharp(downloadPath).resize(400, null).toFile(outputpath);
      fs.unlinkSync(downloadPath);
      downloadPath = outputpath;
    }
    const { secure_url } = await uploadNftImageCloudinary(downloadPath);
    fs.unlinkSync(downloadPath);
    this.thumbnail = secure_url;
  }
}
