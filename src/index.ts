import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
} from 'discord.js';
import { REST, Routes } from 'discord.js';

import {
  handleAccountLinkCommand,
  handleAccountLinkSlashCommand,
  commands,
} from './discord/AccountLinkCommands';
import { DiscordMessageRouter } from './discord/DiscordMessageRouter';
import type { DiscordUserId } from './types';
import { startAuthServer } from './server/authServer';

// ⬇️ import all your services
import {
  accountLinkChallengeService,
  accountLinkVerificationService,
  accountLinkPersistenceService,
  trader,
  readService,
  aiReadExplainer,
} from './wire';
import { createBuildValidationContext } from './backend/buildValidationContext';

// ---- Discord Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // REQUIRED
  ],
});

const buildValidationContext = createBuildValidationContext({
  accountLinkPersistenceService,
  polymarketReadService: readService,
});

const accountLinkDeps = {
  challengeService: accountLinkChallengeService,
  verificationService: accountLinkVerificationService,
  persistenceService: accountLinkPersistenceService,
  trader,
  nowMs: () => Date.now(),
};

// ---- Router ----
const router = new DiscordMessageRouter({
  readService,
  trader,
  buildValidationContext,
  nowMs: () => Date.now(),
  readExplainer: aiReadExplainer,
});

// ---- Ready ----
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

// ---- Slash Command Handler ----
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const commandName = interaction.commandName;
  if (commandName !== 'connect' && commandName !== 'verify' && commandName !== 'disconnect' && commandName !== 'status' && commandName !== 'balance') {
    return;
  }

  try {
    await handleAccountLinkSlashCommand(interaction, accountLinkDeps);
  } catch (error) {
    console.error('Failed to handle slash command interaction:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Unable to process that command right now. Please try again.',
        ephemeral: true,
      });
    }
  }
});

// ---- Message Handler ----
const processedMessages = new Set<string>();

// Per-user command cooldown (5 seconds between commands)
const COOLDOWN_MS = 5_000;
const userCooldowns = new Map<string, number>();

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Only respond when the bot is @mentioned
  if (!message.mentions.has(client.user!)) return;

  // Deduplicate — prevent double-processing if multiple instances or events fire
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  // Keep the set bounded — evict oldest 100 when over 500
  if (processedMessages.size > 500) {
    const iter = processedMessages.values();
    for (let i = 0; i < 100; i++) {
      const v = iter.next().value;
      if (v) processedMessages.delete(v);
    }
  }

  const discordUserId = message.author.id as DiscordUserId;

  // Per-user cooldown check
  const lastCmd = userCooldowns.get(discordUserId) ?? 0;
  if (Date.now() - lastCmd < COOLDOWN_MS) {
    await message.reply('⏳ Please wait a few seconds between commands.');
    return;
  }
  userCooldowns.set(discordUserId, Date.now());

  // Strip the bot mention from the message text
  const text = message.content.replace(/<@!?\d+>/g, '').trim();

  try {
    const isAccountCommand =
      /^connect\s+account$/i.test(text.trim()) ||
      /^verify\s+\S+\s+\S+\s+.+$/i.test(text.trim()) ||
      /^disconnect$/i.test(text.trim());

    if (isAccountCommand) {
      const linkResponse = await handleAccountLinkCommand(text, discordUserId, accountLinkDeps);
      await message.reply(linkResponse);
      return;
    }

    const result = await router.routeMessage(text, discordUserId);

    // Plain text response
    if (result.type === 'text') {
      await message.reply(result.content);
      return;
    }

    // Trade confirmation — send embed with Confirm / Cancel buttons
    const actionEmoji = result.action === 'BUY' ? '🟢' : '🔴';
    const outcomeLabel = result.outcome === 'YES' ? 'UP / YES' : 'DOWN / NO';
    const embed = new EmbedBuilder()
      .setColor(result.action === 'BUY' ? 0x00c853 : 0xd50000)
      .setTitle(`${actionEmoji} Confirm ${result.action} Order`)
      .addFields(
        { name: '📊 Market', value: result.marketQuestion, inline: false },
        { name: '🎯 Side', value: outcomeLabel, inline: true },
        { name: '💵 Amount', value: `$${result.amountDollars}`, inline: true },
      )
      .setFooter({ text: 'Expires in 60 seconds — only you can confirm this trade.' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm:${result.confirmId}`)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`cancel:${result.confirmId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌'),
    );

    const confirmMsg = await message.reply({ embeds: [embed], components: [row] });

    try {
      const interaction = await confirmMsg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === message.author.id,
        time: 60_000,
      });

      await interaction.deferUpdate();

      if (interaction.customId.startsWith('confirm:')) {
        const tradeResult = await router.executePendingTrade(result.confirmId);
        const resultText = tradeResult ?? '❌ Trade expired or was already cancelled.';
        await confirmMsg.edit({
          content: resultText,
          embeds: [],
          components: [],
        });
      } else {
        router.cancelPendingTrade(result.confirmId);
        await confirmMsg.edit({
          content: '❌ **Trade cancelled.**',
          embeds: [],
          components: [],
        });
      }
    } catch {
      // Timed out — 60s expired with no click
      router.cancelPendingTrade(result.confirmId);
      await confirmMsg.edit({
        content: '⏰ **Trade confirmation timed out.** Place the order again if you\'d like to proceed.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  } catch {
    await message.reply('Unable to process your request right now. Please try again.');
  }
});

function isDiscordConnectTimeout(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return value?.code === 'UND_ERR_CONNECT_TIMEOUT' || value?.message?.includes('Connect Timeout Error') === true;
}

// ---- Login ----
async function loginWithRetry(delayMs = 5000): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error('Missing DISCORD_BOT_TOKEN in environment');
  }

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await client.login(botToken);
      return;
    } catch (error) {
      console.error(`Discord login failed (attempt ${attempt}):`, error instanceof Error ? error.message : 'unknown error');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---- Auth Server ----
startAuthServer();

async function registerSlashCommands(): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!botToken || !clientId) {
    console.warn('Skipping slash command registration: missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(botToken);
  const guildId = process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  const scopeLabel = guildId ? `guild ${guildId}` : 'global';

  try {
    console.log(`Refreshing ${scopeLabel} application (/) commands...`);
    await rest.put(route, { body: commands.map(command => command.toJSON()) });
    console.log('✅ Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Failed to register (/) commands:', error);
  }
}

void registerSlashCommands();
void loginWithRetry();

process.on('unhandledRejection', (reason) => {
  if (isDiscordConnectTimeout(reason)) {
    console.warn('Discord request timed out. Retrying...');
    return;
  }
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  if (isDiscordConnectTimeout(error)) {
    console.warn('Discord connection timed out. Keeping process alive for retries...');
    return;
  }
  console.error('Uncaught exception:', error);
  process.exit(1);
});