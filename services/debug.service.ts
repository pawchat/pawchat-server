'use strict';

import { Service, ServiceBroker, Context } from 'moleculer';

export default class TestService extends Service {
  public constructor(public broker: ServiceBroker) {
    super(broker);

    this.parseServiceSchema({
      name: 'debug',
      actions: {
        echo: {
          rest: {
            method: 'GET',
            path: '/hello',
          },
          params: {
            name: 'string',
          },
          handler: this.echo,
        },
      },
    });
  }

  // Action
  public echo(ctx: Context<{ name: string }>): string {
    return `Hello ${
      ctx.params.name
    }, \nHere is your meta info: ${JSON.stringify(ctx.meta, null, 2)}`;
  }
}