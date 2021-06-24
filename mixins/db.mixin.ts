import { Context, ServiceSchema } from 'moleculer';
import { sync as mkdirSync } from 'mkdirp';
import * as path from 'path';
import BaseDBService, { MoleculerDB } from 'moleculer-db';
import type MongooseDbAdapter from 'moleculer-db-adapter-mongoose';
import type { Document } from 'mongoose';

type EntityChangedType = 'created';

// @ts-ignore
/*extends MoleculerDB<MongooseDbAdapter<T>>*/
export interface PawDbService<T extends Document> {
  entityChanged(type: EntityChangedType, json: {}, ctx: Context): Promise<void>;

  adapter: MongooseDbAdapter<T>;
}

export const PawDbService = (collection: string): Partial<ServiceSchema> => {
  if (process.env.MONGO_URI) {
    // Mongo adapter
    const MongooseDbAdapter = require('moleculer-db-adapter-mongoose');
    const model = require(`../schemas/${collection}`);

    return {
      mixins: [BaseDBService],
      adapter: new MongooseDbAdapter(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }),
      model,
      collection,
    };
  }

  // --- NeDB fallback DB adapter

  // Create data folder
  mkdirSync(path.resolve('./data'));

  return {
    mixins: [BaseDBService],
    adapter: new BaseDBService.MemoryAdapter({
      filename: `./data/${collection}.db`,
    }),
    methods: {
      /**
       * 实体变更时触发事件
       */
      async entityChanged(type, json, ctx) {
        await this.clearCache();
        const eventName = `${this.name}.entity.${type}`;
        this.broker.emit(eventName, { meta: ctx.meta, entity: json });
      },
    },
  };
};