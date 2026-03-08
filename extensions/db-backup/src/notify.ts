import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type TelegramNotifier = {
  send: (text: string) => Promise<void>;
};

/**
 * Build a notifier that sends messages to a configured Telegram chat.
 * Lazily resolves the Telegram API at send time so it works even when
 * the plugin registers before the Telegram provider starts.
 */
export function createTelegramNotifier(
  api: OpenClawPluginApi,
  chatId: string | undefined,
): TelegramNotifier | undefined {
  if (!chatId) {
    return undefined;
  }

  return {
    send: async (text: string) => {
      const telegram = api.runtime.channel?.telegram;
      if (!telegram?.sendMessageTelegram) {
        api.logger.warn("db-backup: Telegram channel not available, skipping notification");
        return;
      }
      try {
        await telegram.sendMessageTelegram(chatId, text, {});
      } catch (err) {
        api.logger.warn(`db-backup: failed to send Telegram notification: ${err}`);
      }
    },
  };
}
