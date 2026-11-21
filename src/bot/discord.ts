import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger, type LogSink } from '../log.js';
import { parseChannelId, parseGuildId } from '../ids.js';
import { safeText } from '../safe-text.js';
import type { BotConfig } from './config.js';
import { isBotSubcommand, type BotCommand, type BotCore, type BotMessage } from './core.js';

export const transcriptCommand = new SlashCommandBuilder()
  .setName('transcript')
  .setDescription('YouTube transcript bot setup')
  .addSubcommand((s) =>
    s
      .setName('set-key')
      .setDescription('Set the Gemini API key used for this server')
      .addStringOption((o) =>
        o.setName('key').setDescription('Your Gemini API key').setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s.setName('remove-key').setDescription('Delete the Gemini API key for this server'),
  )
  .addSubcommand((s) =>
    s
      .setName('enable')
      .setDescription('Enable the transcript bot in this channel (and its threads)'),
  )
  .addSubcommand((s) =>
    s.setName('disable').setDescription('Disable the transcript bot in this channel'),
  )
  .toJSON();

// All Discord-facing wiring lives here; the bot brain is the injected core.
export async function startDiscordBot(
  config: BotConfig,
  core: BotCore,
  sink: LogSink,
): Promise<Client> {
  const log = createLogger(sink);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const rest = new REST().setToken(config.discordToken);

  const register = async (guildId: string): Promise<void> => {
    if (!client.user) return;
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
        body: [transcriptCommand],
      });
      log('commands_registered', { guild: parseGuildId(guildId) });
    } catch {
      log('command_registration_failed', { guild: parseGuildId(guildId) });
    }
  };

  client.once(Events.ClientReady, (ready) => {
    log('discord_ready', { count: ready.guilds.cache.size });
    for (const guild of ready.guilds.cache.values()) void register(guild.id);
  });
  client.on(Events.GuildCreate, (guild) => void register(guild.id));

  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId) return;
    const msg: BotMessage = {
      guildId: message.guildId,
      channelId: message.channelId,
      parentChannelId: message.channel.isThread()
        ? (message.channel.parentId ?? undefined)
        : undefined,
      authorIsBot: message.author.bot,
      // Lazy on purpose: the core reads content only after the channel
      // allowlist check, so the bot never reads text in channels that are
      // not enabled.
      get content() {
        return message.content;
      },
    };
    void core
      .handleMessage(msg, {
        react: async (emoji) => {
          await message.react(emoji);
        },
        reply: async (content, files) => {
          await message.channel.send({
            content,
            files: files.map((f) => ({ attachment: Buffer.from(f.data, 'utf8'), name: f.name })),
          });
        },
      })
      .catch(() =>
        log('message_handler_failed', {
          guild: parseGuildId(msg.guildId),
          channel: parseChannelId(msg.channelId),
        }),
      );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'transcript') return;
    const guildId = interaction.guildId;
    if (!guildId) {
      void interaction.reply({
        content: safeText('bot.dm_unsupported'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (!isBotSubcommand(subcommand)) {
      void interaction.reply({
        content: safeText('bot.unknown_subcommand'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const perms = interaction.memberPermissions;
    const cmd: BotCommand = {
      guildId,
      channelId: interaction.channelId,
      memberCanManageGuild:
        perms !== null && typeof perms === 'object'
          ? perms.has(PermissionFlagsBits.ManageGuild)
          : false,
      subcommand,
      key: interaction.options.getString('key') ?? undefined,
    };
    void core
      .handleCommand(cmd, {
        replyEphemeral: async (content) => {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        },
      })
      .catch(() =>
        log('command_handler_failed', {
          guild: parseGuildId(guildId),
          channel: parseChannelId(interaction.channelId),
        }),
      );
  });

  await client.login(config.discordToken);
  return client;
}
