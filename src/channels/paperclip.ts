/**
 * Paperclip channel adapter for NanoClaw.
 *
 * Implements the OpenClaw Gateway Protocol v3 as a WebSocket server.
 * Paperclip connects to this server (instead of the external nandy-gateway)
 * and submits agent tasks via the `agent` method.
 *
 * Configuration (in .env):
 *   PAPERCLIP_GATEWAY_TOKEN   — Auth token Paperclip sends (required)
 *   PAPERCLIP_GATEWAY_PORT    — WS server port (default: 18790)
 *   PAPERCLIP_GROUP_FOLDER    — Group folder name (default: "paperclip")
 *
 * Paperclip agent adapterConfig must have:
 *   { "url": "ws://127.0.0.1:18790", "sessionKeyStrategy": "fixed" }
 * and the x-openclaw-token header or connect.params.auth.token set to
 * the value of PAPERCLIP_GATEWAY_TOKEN.
 */

import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const PROTOCOL_VERSION = 3;

// How long (ms) to wait for an agent response before timing out the WS call.
const TASK_TIMEOUT_MS = 110_000;

interface PendingTask {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PaperclipChannel implements Channel {
  name = 'paperclip';

  private wss: WebSocketServer | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private gatewayToken: string;
  private port: number;
  private groupJid: string;
  private groupFolder: string;

  // FIFO queue of pending WS responses waiting for agent output
  private pendingTasks: PendingTask[] = [];

  constructor(opts: ChannelOpts) {
    this.opts = opts;

    const env = readEnvFile([
      'PAPERCLIP_GATEWAY_TOKEN',
      'PAPERCLIP_GATEWAY_PORT',
      'PAPERCLIP_GROUP_FOLDER',
    ]);

    this.gatewayToken = env.PAPERCLIP_GATEWAY_TOKEN ?? '';
    this.port = parseInt(env.PAPERCLIP_GATEWAY_PORT ?? '18790', 10);
    this.groupFolder = env.PAPERCLIP_GROUP_FOLDER ?? 'paperclip';
    this.groupJid = `paperclip:main`;
  }

  async connect(): Promise<void> {
    // Auto-register the Paperclip group if it isn't already registered
    const groups = this.opts.registeredGroups();
    if (!groups[this.groupJid] && this.opts.onRegisterGroup) {
      const group: RegisteredGroup = {
        name: 'Paperclip',
        folder: this.groupFolder,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      };
      this.opts.onRegisterGroup(this.groupJid, group);
      logger.info(
        { jid: this.groupJid, folder: this.groupFolder },
        'Paperclip group auto-registered',
      );
    }

    this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.wss.on('error', (err) => {
      logger.error({ err }, 'Paperclip WS server error');
    });

    this.connected = true;
    logger.info({ port: this.port }, 'Paperclip gateway WS server listening');
  }

  private handleConnection(ws: WebSocket): void {
    let authenticated = false;
    const nonce = crypto.randomBytes(16).toString('hex');

    const send = (obj: object): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    // Send challenge immediately on connection
    send({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce, protocolVersions: [PROTOCOL_VERSION] },
    });

    ws.on('message', async (data: Buffer) => {
      let frame: {
        type: string;
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        frame = JSON.parse(data.toString()) as typeof frame;
      } catch {
        return;
      }

      if (frame.type !== 'req') return;

      const { id, method, params } = frame;

      if (method === 'connect') {
        const token =
          (params?.auth as Record<string, string> | undefined)?.token ?? '';
        if (token !== this.gatewayToken) {
          send({
            type: 'res',
            id,
            ok: false,
            error: { code: 'unauthorized', message: 'Invalid token' },
          });
          ws.close();
          return;
        }
        authenticated = true;
        send({
          type: 'res',
          id,
          ok: true,
          payload: { protocol: PROTOCOL_VERSION, gateway: 'nanoclaw-paperclip' },
        });
        logger.debug('Paperclip client authenticated');
        return;
      }

      if (!authenticated) {
        send({
          type: 'res',
          id,
          ok: false,
          error: { code: 'unauthorized', message: 'Not authenticated' },
        });
        return;
      }

      if (method === 'agent') {
        const message = String(params?.message ?? '');
        const runId = crypto.randomUUID();

        // Accept the task immediately
        send({
          type: 'res',
          id,
          ok: true,
          payload: { status: 'accepted', runId },
        });

        // Send initial streaming event so Paperclip knows we're working
        send({
          type: 'event',
          event: 'agent',
          seq: 0,
          payload: {
            runId,
            status: 'streaming',
            delta: { type: 'text', text: '' },
          },
        });

        logger.info(
          { runId, msgLen: message.length },
          'Paperclip task received',
        );

        // Enqueue a pending task — sendMessage() will resolve it
        const taskPromise = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingTasks = this.pendingTasks.filter(
              (t) => t.resolve !== resolve,
            );
            reject(new Error(`Task ${runId} timed out`));
          }, TASK_TIMEOUT_MS);

          this.pendingTasks.push({ resolve, reject, timer });
        });

        // Store the inbound message so the group queue picks it up
        this.opts.onMessage(this.groupJid, {
          id: runId,
          chat_jid: this.groupJid,
          sender: 'paperclip',
          sender_name: 'Paperclip',
          content: message,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        } as NewMessage);

        // Wait for the agent to respond (via sendMessage), then stream it back
        taskPromise
          .then((output) => {
            const chunkSize = 300;
            let seq = 1;
            for (let i = 0; i < output.length; i += chunkSize) {
              send({
                type: 'event',
                event: 'agent',
                seq: seq++,
                payload: {
                  runId,
                  status: 'streaming',
                  delta: { type: 'text', text: output.slice(i, i + chunkSize) },
                },
              });
            }
            send({
              type: 'event',
              event: 'agent',
              seq,
              payload: { runId, status: 'ok', output, usage: {} },
            });
            logger.info({ runId, outputLen: output.length }, 'Paperclip task done');
          })
          .catch((err: Error) => {
            logger.error({ runId, err }, 'Paperclip task error');
            send({
              type: 'event',
              event: 'agent',
              seq: 1,
              payload: {
                runId,
                status: 'error',
                error: { message: String(err.message) },
              },
            });
          });

        return;
      }

      // Passthrough handlers for other protocol methods
      if (method === 'agent.wait') {
        send({ type: 'res', id, ok: true, payload: { status: 'ok' } });
        return;
      }
      if (method === 'device.pair.list') {
        send({ type: 'res', id, ok: true, payload: { devices: [] } });
        return;
      }
      if (method === 'device.pair.approve') {
        send({ type: 'res', id, ok: true, payload: {} });
        return;
      }

      send({
        type: 'res',
        id,
        ok: false,
        error: { code: 'not_found', message: `Unknown method: ${method ?? ''}` },
      });
    });

    ws.on('close', () => {
      logger.debug('Paperclip client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'Paperclip WS connection error');
    });
  }

  /**
   * Called by the orchestrator when the agent produces output for this channel.
   * Resolves the oldest pending task in the FIFO queue.
   */
  async sendMessage(_jid: string, text: string): Promise<void> {
    const task = this.pendingTasks.shift();
    if (!task) {
      logger.warn(
        { textLen: text.length },
        'Paperclip: sendMessage called with no pending task',
      );
      return;
    }
    clearTimeout(task.timer);
    task.resolve(text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('paperclip:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // Reject all pending tasks
    for (const task of this.pendingTasks) {
      clearTimeout(task.timer);
      task.reject(new Error('Channel disconnecting'));
    }
    this.pendingTasks = [];
    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // Typing indicator is not applicable for Paperclip
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }
}

registerChannel('paperclip', (opts: ChannelOpts) => {
  const env = readEnvFile(['PAPERCLIP_GATEWAY_TOKEN']);
  if (!env.PAPERCLIP_GATEWAY_TOKEN) {
    logger.warn(
      'Paperclip: PAPERCLIP_GATEWAY_TOKEN not set in .env — skipping',
    );
    return null;
  }
  return new PaperclipChannel(opts);
});
