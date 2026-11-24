import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentPlugin, capabilitiesPlugin, type AgentRuntime } from '@extendo/agent';
import type { Ctx, Logger, Plugin, Provider, ProviderInfo, Registry } from '@extendo/contracts';
import { Context, PluginLoader, profileEntries, type PluginCatalog, type Profile } from '@extendo/kernel';
import { demoToolsPlugin, providersPlugin } from '@extendo/providers';
import { gitPullRequestReader, pullRequestPlugin, scriptedPullRequestReader, type PullRequestReader } from '@extendo/pullrequests';
import { sessionPlugin, type SessionStore } from '@extendo/session';
import { swarmPlugin, type SwarmRuntime } from '@extendo/swarm';
import { workspaceToolsPlugin } from '@extendo/tools';
import { demoPullRequests, seedDemo } from './demo.js';
import { ExtensionWorkshop } from './extensions.js';
import { previewFor } from './preview.js';
import { statePlugin, type WorkspaceState } from './state.js';
import { ThreadViewer } from './threads.js';

export type RuntimeMode = 'web' | 'headless' | 'sdk';

export interface RuntimeOptions {
  mode?: RuntimeMode;
  dataDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  profile?: Profile;
  plugins?: PluginCatalog;
  seed?: boolean;
  pullRequests?: PullRequestReader;
}

export interface Runtime {
  mode: RuntimeMode;
  ctx: Ctx;
  sessions: SessionStore;
  workspace: WorkspaceState;
  agent: AgentRuntime;
  swarm: SwarmRuntime;
  pullRequests: PullRequestReader;
  viewer: ThreadViewer;
  extensions: ExtensionWorkshop;
  providers(): ProviderInfo[];
  model(provider: string, model?: string): { provider: string; model: string };
  close(): Promise<void>;
}

export const defaultDataDir = (env: NodeJS.ProcessEnv = process.env) => resolve(env.EXTENDO_HOME ?? join(homedir(), '.extendo'));

export function defaultProfile(mode: RuntimeMode): Profile {
  const base = ['capabilities', 'sessions', 'workspace', 'providers', 'workspace-tools', 'demo-tools', 'pull-requests', 'instructions', 'agent', 'swarm'];
  return {
    name: `extendo-${mode}`,
    bundles: [
      { name: 'base', rows: base.map((id) => ({ id, plugin: id })) },
      ...(mode === 'web' ? [{ name: 'web', rows: [{ id: 'demo-seed', plugin: 'demo-seed' }] }] : []),
    ],
  };
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const mode = options.mode ?? 'web';
  const dataDir = options.dataDir ?? defaultDataDir(options.env);
  const pullRequests = options.pullRequests
    ?? (mode === 'web' ? scriptedPullRequestReader(demoPullRequests()) : gitPullRequestReader());

  const loader = new PluginLoader(new Context(options.logger));
  const catalog: PluginCatalog = new Map([
    ['capabilities', capabilitiesPlugin],
    ['sessions', () => sessionPlugin(dataDir)],
    ['workspace', () => statePlugin(dataDir)],
    ['providers', () => providersPlugin(options.env)],
    ['workspace-tools', workspaceToolsPlugin],
    ['demo-tools', demoToolsPlugin],
    ['pull-requests', () => pullRequestPlugin({ reader: pullRequests })],
    ['swarm', swarmPlugin],
    ['agent', agentPlugin],
    ['instructions', () => ({ name: 'instructions', apply(ctx) {
      ctx.get<Registry<{ name: string; text: (input: { session: { cwd: string } }) => string }>>('system').register(ctx, 'extendo', {
        name: 'extendo',
        text: ({ session }) => `You are Extendo, a local coding assistant. The project is at ${session.cwd}. Read before you edit, keep changes small, and report what you actually verified.`,
      });
    } })],
    ...(mode === 'web' ? [['demo-seed', () => ({ name: 'demo-seed', apply() {} })] as [string, () => Plugin]] : []),
    ...(options.plugins ?? []),
  ] as [string, (config?: import('@extendo/contracts').JsonValue) => Plugin][]);

  try {
    await loader.mountEntries(profileEntries(options.profile ?? defaultProfile(mode), catalog));
    const ctx = loader.ctx;
    const sessions = ctx.get<SessionStore>('sessions');
    const workspace = ctx.get<WorkspaceState>('workspace');
    const agent = ctx.get<AgentRuntime>('agent');
    const swarm = ctx.get<SwarmRuntime>('swarm');
    const extensions = new ExtensionWorkshop({ dir: resolve(dataDir, 'plugins'), loader, ctx, logger: options.logger });
    await extensions.mountInstalled();

    if (mode === 'web' && options.seed !== false) seedDemo({ workspace, sessions, dataDir });
    if (options.cwd) workspace.openProject(options.cwd);

    const providers = () => {
      const builtIn = ctx.get<ProviderInfo[]>('provider-info');
      const adapters = ctx.get<Registry<Provider>>('providers').list();
      return [
        ...builtIn.map((info) => ({ ...info, configured: adapters.some(({ id }) => id === info.id) })),
        ...adapters.filter(({ id }) => !builtIn.some((info) => info.id === id)).map(({ id }) => ({ id, name: id, model: id, configured: true })),
      ];
    };

    const viewer = new ThreadViewer({ workspace, sessions, agent, pullRequests, preview: previewFor });
    return {
      mode, ctx, sessions, workspace, agent, swarm, pullRequests, viewer, extensions, providers,
      model(provider, model) {
        const info = providers().find(({ id }) => id === provider);
        if (!info) throw new Error('Unknown provider');
        if (!info.configured) throw new Error(`${info.name} is not configured`);
        return { provider, model: model ?? info.model };
      },
      async close() {
        await agent.shutdown();
        loader.dispose();
      },
    };
  } catch (error) {
    loader.dispose();
    throw error;
  }
}
