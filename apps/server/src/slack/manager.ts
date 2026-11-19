import type { EventHub } from '../api/event-hub.ts';
import type { EngineDeps } from '../engine/deps.ts';
import { SlackBridge } from './bridge.ts';
import type { SlackEvent } from './socket.ts';

/**
 * Runs the Slack bridge for projects (a thread per project, replies that steer it) on whatever
 * is saved on the Settings page. The bridge holds the tokens it started with, so a change to
 * them closes it and starts a new one; the allowed people and the dashboard link are read each
 * time and need no restart.
 */
export class SlackManager {
  readonly #deps: EngineDeps;
  readonly #hub: EventHub;
  readonly #handlePrReply: ((event: SlackEvent) => Promise<boolean>) | undefined;
  #bridge: SlackBridge | null = null;
  #key = '';
  #queue: Promise<void> = Promise.resolve();

  constructor(
    deps: EngineDeps,
    hub: EventHub,
    handlePrReply?: (event: SlackEvent) => Promise<boolean>,
  ) {
    this.#deps = deps;
    this.#hub = hub;
    this.#handlePrReply = handlePrReply;
  }

  /**
   * Makes the bridge match the config. Without `force` nothing happens unless the tokens or the
   * channel changed; Save on the Settings page forces it, so a bridge that failed to start gets
   * another try with the same values.
   */
  apply(force = false): Promise<void> {
    // One at a time, so two quick saves can't leave two bridges open.
    this.#queue = this.#queue.then(() => this.#apply(force)).catch(() => undefined);
    return this.#queue;
  }

  async #apply(force: boolean): Promise<void> {
    const { config } = this.#deps;
    const key = JSON.stringify([
      config.SLACK_BOT_TOKEN,
      config.SLACK_APP_TOKEN,
      config.SLACK_CHANNEL_ID,
    ]);
    if (key === this.#key && !force) return;
    await this.#bridge?.close().catch(() => undefined);
    const wasOn = this.#bridge !== null;
    this.#bridge = null;
    this.#key = key;
    if (!config.SLACK_BOT_TOKEN || !config.SLACK_CHANNEL_ID) {
      if (wasOn) console.log('Slack for projects is off.');
      return;
    }
    const bridge = new SlackBridge(this.#deps, this.#hub, undefined, this.#handlePrReply);
    try {
      await bridge.start();
      this.#bridge = bridge;
      console.log(
        `Slack: posting to ${config.SLACK_CHANNEL_ID}${config.SLACK_APP_TOKEN ? ', listening for replies' : ' (add an app-level token on the Settings page for replies)'}`,
      );
    } catch (error) {
      await bridge.close().catch(() => undefined);
      console.error(`Slack is off: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Whether the bridge is running. */
  get running(): boolean {
    return this.#bridge !== null;
  }

  async close(): Promise<void> {
    await this.#queue;
    await this.#bridge?.close().catch(() => undefined);
    this.#bridge = null;
  }
}
