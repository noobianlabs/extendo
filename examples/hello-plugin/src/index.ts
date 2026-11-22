import { definePlugin, type Command, type Registry, type Tool } from '@extendo/plugin-sdk';
import { z } from 'zod';

export default definePlugin({
  name: 'hello',
  apply(ctx) {
    return ctx.inject(['tools', 'commands'], (scope) => {
      const hello: Tool<{ name: string }, string> = {
        name: 'hello',
        description: 'Greet a person by name.',
        input: z.object({ name: z.string().trim().min(1).max(80) }),
        readOnly: true,
        async execute({ name }) {
          return `Hello, ${name}.`;
        },
      };
      scope.get<Registry<Tool>>('tools').register(scope, hello.name, hello);
      scope.emit('tools/register', { name: hello.name });

      const command: Command = {
        name: 'hello',
        description: 'Print a greeting without a model turn.',
        run(args) {
          scope.logger.info(`Hello, ${args.join(' ') || 'there'}.`);
        },
      };
      scope.get<Registry<Command>>('commands').register(scope, command.name, command);
    });
  },
});
