import { Context, Errors } from 'moleculer';
import { TcCacheCleaner } from '../../../mixins/cache.cleaner.mixin';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type {
  UserDocument,
  UserLoginRes,
  UserModel,
} from '../../../models/user/user';
import {
  TcService,
  TcDbService,
  TcContext,
  TcPureContext,
  UserJWTPayload,
  config,
} from 'tailchat-server-sdk';
import { DataNotFoundError, EntityError } from '../../../lib/errors';
import { generateRandomStr, getEmailAddress } from '../../../lib/utils';
import { Types } from 'mongoose';
import type { TFunction } from 'i18next';

/**
 * 用户服务
 */
interface UserService extends TcService, TcDbService<UserDocument, UserModel> {}
class UserService extends TcService {
  get serviceName() {
    return 'user';
  }

  onInit() {
    this.registerLocalDb(require('../../../models/user/user').default);
    this.registerMixin(TcCacheCleaner(['cache.clean.user']));

    // Public fields
    this.registerDbField([
      '_id',
      'username',
      'email',
      'avatar',
      'nickname',
      'discriminator',
      'temporary',
      'createdAt',
    ]);

    this.registerAction('login', this.login, {
      rest: 'POST /login',
      params: {
        username: [{ type: 'string', optional: true }],
        email: [{ type: 'string', optional: true }],
        password: 'string',
      },
    });
    this.registerAction('register', this.register, {
      rest: 'POST /register',
      params: {
        username: [{ type: 'string', optional: true }],
        email: [{ type: 'string', optional: true }],
        password: 'string',
      },
    });
    this.registerAction('modifyPassword', this.modifyPassword, {
      rest: 'POST /modifyPassword',
      params: {
        oldPassword: 'string',
        newPassword: 'string',
      },
    });
    this.registerAction('createTemporaryUser', this.createTemporaryUser, {
      params: {
        nickname: 'string',
      },
    });
    this.registerAction('claimTemporaryUser', this.claimTemporaryUser, {
      params: {
        userId: 'string',
        username: [{ type: 'string', optional: true }],
        email: 'string',
        password: 'string',
      },
    });
    this.registerAction('resolveToken', this.resolveToken, {
      cache: {
        keys: ['token'],
        ttl: 60 * 60, // 1 hour
      },
      params: {
        token: 'string',
      },
    });
    this.registerAction('checkTokenValid', this.checkTokenValid, {
      cache: {
        keys: ['token'],
        ttl: 60 * 60, // 1 hour
      },
      params: {
        token: 'string',
      },
    });
    this.registerAction('whoami', this.whoami);
    this.registerAction(
      'searchUserWithUniqueName',
      this.searchUserWithUniqueName,
      {
        params: {
          uniqueName: 'string',
        },
      }
    );
    this.registerAction('getUserInfo', this.getUserInfo, {
      params: {
        userId: 'string',
      },
    });
    this.registerAction('updateUserField', this.updateUserField, {
      params: {
        fieldName: 'string',
        fieldValue: 'any',
      },
    });
    this.registerAction('ensurePluginBot', this.ensurePluginBot, {
      params: {
        /**
         * 用户名唯一id, 创建的用户邮箱会为 <botId>@tailchat-plugin.com
         */
        botId: 'string',
        nickname: 'string',
        avatar: { type: 'string', optional: true },
      },
    });
  }

  /**
   * jwt秘钥
   */
  get jwtSecretKey() {
    return config.jwtSecret;
  }

  /**
   * 生成hash密码
   */
  hashPassword = async (password: string): Promise<string> =>
    bcrypt.hash(password, 10);
  /**
   * 对比hash密码是否正确
   */
  comparePassword = async (password: string, hash: string): Promise<boolean> =>
    bcrypt.compare(password, hash);

  /**
   * 用户登录
   * 登录可以使用用户名登录或者邮箱登录
   */
  async login(
    ctx: Context<{ username?: string; email?: string; password: string }, any>
  ): Promise<UserLoginRes> {
    const { username, email, password } = ctx.params;
    const { t } = ctx.meta;

    let user: UserDocument;
    if (typeof username === 'string') {
      user = await this.adapter.findOne({ username });
      if (!user) {
        throw new EntityError(t('用户不存在, 请检查您的用户名'), 442, '', [
          { field: 'username', message: t('用户名不存在') },
        ]);
      }
    } else if (typeof email === 'string') {
      user = await this.adapter.findOne({ email });
      if (!user) {
        throw new EntityError(t('用户不存在, 请检查您的邮箱'), 422, '', [
          { field: 'email', message: t('邮箱不存在') },
        ]);
      }
    } else {
      throw new EntityError(t('用户名或邮箱为空'), 422, '', [
        { field: 'email', message: t('邮箱不存在') },
      ]);
    }

    const res = await this.comparePassword(password, user.password);
    if (!res)
      throw new EntityError(t('密码错误'), 422, '', [
        { field: 'password', message: t('密码错误') },
      ]);

    // Transform user entity (remove password and all protected fields)
    const doc = await this.transformDocuments(ctx, {}, user);
    return await this.transformEntity(doc, true, ctx.meta.token);
  }

  /**
   * 用户注册
   */
  async register(
    ctx: TcPureContext<
      { username?: string; email?: string; password: string },
      any
    >
  ) {
    const params = { ...ctx.params };
    const t = ctx.meta.t;
    await this.validateEntity(params);

    await this.validateRegisterParams(params, t);

    const nickname = params.username ?? getEmailAddress(params.email);
    const discriminator = await this.adapter.model.generateDiscriminator(
      nickname
    );

    const password = await this.hashPassword(params.password);
    const doc = await this.adapter.insert({
      ...params,
      password,
      nickname,
      discriminator,
      avatar: null,
      createdAt: new Date(),
    });
    const user = await this.transformDocuments(ctx, {}, doc);
    const json = await this.transformEntity(user, true, ctx.meta.token);
    await this.entityChanged('created', json, ctx);
    return json;
  }

  /**
   * 修改密码
   */
  async modifyPassword(
    ctx: TcContext<{
      oldPassword: string;
      newPassword: string;
    }>
  ) {
    const { oldPassword, newPassword } = ctx.params;
    const { userId, t } = ctx.meta;

    const user = await this.adapter.model.findById(userId);
    if (!user) {
      throw new Error(t('用户不存在'));
    }

    const oldPasswordMatched = await this.comparePassword(
      oldPassword,
      user.password
    );
    if (!oldPasswordMatched) {
      throw new Error(t('密码不正确'));
    }

    user.password = await this.hashPassword(newPassword);
    await user.save();

    return true;
  }

  /**
   * 创建临时用户
   */
  async createTemporaryUser(ctx: TcPureContext<{ nickname: string }>) {
    const nickname = ctx.params.nickname;
    const discriminator = await this.adapter.model.generateDiscriminator(
      nickname
    );

    const password = await this.hashPassword(generateRandomStr());
    const doc = await this.adapter.insert({
      email: `${generateRandomStr()}.temporary@msgbyte.com`,
      password,
      nickname,
      discriminator,
      temporary: true,
      avatar: null,
      createdAt: new Date(),
    });
    const user = await this.transformDocuments(ctx, {}, doc);
    const json = await this.transformEntity(user, true);
    await this.entityChanged('created', json, ctx);

    return json;
  }

  /**
   * 认领临时用户
   */
  async claimTemporaryUser(
    ctx: TcPureContext<{
      userId: string;
      username?: string;
      email: string;
      password: string;
    }>
  ) {
    const params = ctx.params;
    const t = ctx.meta.t;

    const user = await this.adapter.findById(params.userId);
    if (!user) {
      throw new DataNotFoundError(t('认领用户不存在'));
    }
    if (!user.temporary) {
      throw new Error(t('该用户不是临时用户'));
    }

    await this.validateRegisterParams(params, t);
    const password = await this.hashPassword(params.password);

    user.username = params.username;
    user.email = params.email;
    user.password = password;
    user.temporary = false;
    await user.save();

    const json = await this.transformEntity(user, true);
    await this.entityChanged('updated', json, ctx);
    return json;
  }

  /**
   * 校验JWT的合法性
   * @param ctx
   * @returns
   */
  async resolveToken(ctx: Context<{ token: string }, any>) {
    const decoded = await this.verifyJWT(ctx.params.token);
    const t = ctx.meta.t;

    if (typeof decoded._id !== 'string') {
      // token 中没有 _id
      throw new EntityError(t('Token 内容不正确'));
    }
    const doc = await this.getById(decoded._id);
    const user = await this.transformDocuments(ctx, {}, doc);
    const json = await this.transformEntity(user, true, ctx.meta.token);
    return json;
  }

  /**
   * 检查授权是否可用
   */
  async checkTokenValid(ctx: Context<{ token: string }>) {
    try {
      await this.verifyJWT(ctx.params.token);

      return true;
    } catch (e) {
      return false;
    }
  }

  async whoami(ctx: TcContext) {
    return ctx.meta ?? null;
  }

  /**
   * 搜索用户
   *
   */
  async searchUserWithUniqueName(ctx: TcContext<{ uniqueName: string }>) {
    const t = ctx.meta.t;
    const uniqueName = ctx.params.uniqueName;
    if (!uniqueName.includes('#')) {
      throw new EntityError(t('请输入带唯一标识的用户名 如: Nickname#0000'));
    }

    const [nickname, discriminator] = uniqueName.split('#');
    const doc = await this.adapter.findOne({
      nickname,
      discriminator,
    });
    const user = await this.transformDocuments(ctx, {}, doc);

    return user;
  }

  /**
   * 获取用户信息
   */
  async getUserInfo(ctx: Context<{ userId: string }>) {
    const userId = ctx.params.userId;

    const doc = await this.adapter.findById(userId);
    const user = await this.transformDocuments(ctx, {}, doc);

    return user;
  }

  async updateUserField(
    ctx: TcContext<{ fieldName: string; fieldValue: string }>
  ) {
    const { fieldName, fieldValue } = ctx.params;
    const t = ctx.meta.t;
    const userId = ctx.meta.userId;
    if (!['nickname', 'avatar'].includes(fieldName)) {
      throw new EntityError(t('该数据不允许修改'));
    }

    const doc = await this.adapter.model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(userId),
        },
        {
          [fieldName]: fieldValue,
        },
        {
          new: true,
        }
      )
      .exec();

    this.cleanCurrentUserCache(ctx);

    return await this.transformDocuments(ctx, {}, doc);
  }

  async ensurePluginBot(
    ctx: TcContext<{
      botId: 'string';
      nickname: 'string';
      avatar: { type: 'string'; optional: true };
    }>
  ): Promise<string> {
    const { botId, nickname, avatar } = ctx.params;
    const email = this.buildPluginBotEmail(botId);

    const bot = await this.adapter.model.findOne(
      {
        email,
      },
      {
        _id: 1,
      }
    );

    if (bot) {
      return String(bot._id);
    }

    // 如果不存在，则创建
    const newBot = await this.adapter.model.create({
      email,
      nickname,
      avatar,
      type: 'pluginBot',
    });

    return String(newBot._id);
  }

  private async cleanCurrentUserCache(ctx: TcContext) {
    const { token } = ctx.meta;
    this.cleanActionCache('resolveToken', [token]);
  }

  /**
   * Transform returned user entity. Generate JWT token if neccessary.
   *
   * @param {Object} user
   * @param {Boolean} withToken
   */
  private async transformEntity(user: any, withToken: boolean, token?: string) {
    if (user) {
      //user.avatar = user.avatar || "https://www.gravatar.com/avatar/" + crypto.createHash("md5").update(user.email).digest("hex") + "?d=robohash";
      if (withToken) {
        if (token !== undefined) {
          // 携带了token
          try {
            await this.verifyJWT(token);
            // token 可用, 原样传回
            user.token = token;
          } catch (err) {
            // token 不可用, 生成一个新的返回
            user.token = this.generateJWT(user);
          }
        } else {
          // 没有携带token 生成一个
          user.token = this.generateJWT(user);
        }
      }
    }

    return user;
  }

  private async verifyJWT(token: string): Promise<UserJWTPayload> {
    const decoded = await new Promise<UserJWTPayload>((resolve, reject) => {
      jwt.verify(token, this.jwtSecretKey, (err, decoded: UserJWTPayload) => {
        if (err) return reject(err);

        resolve(decoded);
      });
    });

    return decoded;
  }

  /**
   * 生成jwt
   */
  private generateJWT(user: {
    _id: string;
    nickname: string;
    email: string;
    avatar: string;
  }): string {
    return jwt.sign(
      {
        _id: user._id,
        nickname: user.nickname,
        email: user.email,
        avatar: user.avatar,
      } as UserJWTPayload,
      this.jwtSecretKey,
      {
        expiresIn: '30d',
      }
    );
  }

  /**
   * 校验参数合法性
   */
  private async validateRegisterParams(
    params: {
      username?: string;
      email?: string;
    },
    t: TFunction
  ) {
    if (!params.username && !params.email) {
      throw new Errors.ValidationError(t('用户名或邮箱为空'));
    }

    if (params.username) {
      const found = await this.adapter.findOne({ username: params.username });
      if (found) {
        throw new Errors.MoleculerClientError(t('用户名已存在!'), 422, '', [
          { field: 'username', message: 'is exist' },
        ]);
      }
    }

    if (params.email) {
      const found = await this.adapter.findOne({ email: params.email });
      if (found) {
        throw new Errors.MoleculerClientError(t('邮箱已存在!'), 422, '', [
          { field: 'email', message: 'is exist' },
        ]);
      }
    }
  }

  private buildPluginBotEmail(botId: string) {
    return `${botId}@tailchat-plugin.com`;
  }
}

export default UserService;
