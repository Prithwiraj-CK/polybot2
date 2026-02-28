import { createClient } from '@supabase/supabase-js';
import type { AccountLinkStore } from '../auth/AccountLinkPersistenceService';
import type { DiscordUserId, PolymarketAccountId } from '../types';

/**
 * Supabase-backed account link store.
 *
 * Table: account_links
 *   discord_user_id       TEXT PRIMARY KEY
 *   polymarket_account_id TEXT NOT NULL
 *   linked_at_ms          BIGINT NOT NULL
 *
 * Run this SQL in Supabase Dashboard → SQL Editor:
 *
 *   CREATE TABLE IF NOT EXISTS account_links (
 *     discord_user_id       TEXT PRIMARY KEY,
 *     polymarket_account_id TEXT NOT NULL,
 *     linked_at_ms          BIGINT NOT NULL
 *   );
 */
export class SupabaseAccountLinkStore implements AccountLinkStore {
  private readonly supabase;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
    }
    this.supabase = createClient(url, key);
  }

  public async link(
    discordUserId: DiscordUserId,
    polymarketAccountId: PolymarketAccountId,
    linkedAtMs: number,
  ): Promise<void> {
    const { error } = await this.supabase.from('account_links').upsert(
      {
        discord_user_id: discordUserId,
        polymarket_account_id: polymarketAccountId,
        linked_at_ms: linkedAtMs,
      },
      { onConflict: 'discord_user_id' },
    );
    if (error) throw new Error(`Supabase link error: ${error.message}`);
  }

  public async getLinkedAccount(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null> {
    const { data, error } = await this.supabase
      .from('account_links')
      .select('polymarket_account_id')
      .eq('discord_user_id', discordUserId)
      .single();

    if (error && error.code === 'PGRST116') {
      // No row found
      return null;
    }
    if (error) throw new Error(`Supabase getLinkedAccount error: ${error.message}`);

    return (data?.polymarket_account_id as PolymarketAccountId) ?? null;
  }

  public async unlink(discordUserId: DiscordUserId): Promise<void> {
    const { error } = await this.supabase
      .from('account_links')
      .delete()
      .eq('discord_user_id', discordUserId);
    if (error) throw new Error(`Supabase unlink error: ${error.message}`);
  }
}
