import {
  getModelForClass,
  prop,
  DocumentType,
  ReturnModelType,
} from '@typegoose/typegoose';
import { Base, TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';
import { NAME_REGEXP } from '../lib/const';

export interface User extends Base {}
export class User extends TimeStamps {
  /**
   * 用户名 不可被修改
   * 与email必有一个
   */
  @prop()
  username?: string;

  /**
   * 邮箱 不可被修改
   * 与username必有一个
   */
  @prop({
    index: true,
    unique: true,
  })
  email?: string;

  @prop()
  password!: string;

  /**
   * 可以被修改的显示名
   */
  @prop({
    trim: true,
    match: NAME_REGEXP,
  })
  nickname!: string;

  /**
   * 识别器, 跟username构成全局唯一的用户名
   * 用于搜索
   * <username>#<discriminator>
   */
  @prop()
  discriminator: string;

  /**
   * 头像
   */
  @prop()
  avatar?: string;

  /**
   * 生成身份识别器
   * 0001 - 9999
   */
  public static generateDiscriminator(
    this: ReturnModelType<typeof User>,
    nickname: string
  ): Promise<string> {
    let restTimes = 10; // 最多找10次
    const checkDiscriminator = async () => {
      const discriminator = String(
        Math.floor(Math.random() * 9999) + 1
      ).padStart(4, '0');

      const doc = await this.findOne({
        nickname,
        discriminator,
      }).exec();
      restTimes--;

      if (doc !== null) {
        // 已存在, 换一个
        if (restTimes <= 0) {
          throw new Error('Cannot find space discriminator');
        }

        return checkDiscriminator();
      }

      return discriminator;
    };

    return checkDiscriminator();
  }
}

export type UserDocument = DocumentType<User>;

const model = getModelForClass(User);

export type UserModel = typeof model;

export default model;