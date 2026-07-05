import { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { EntityLike } from 'telegram/define';
import * as fs from 'fs';
import * as path from 'path';
import { Config, getConfigDirectory } from './config';
import { Logger } from './logger';

interface GroupInfo {
  id: string;
  title: string;
  entity: EntityLike;
  lastMessageId?: number;
}

// Функция для чтения списка ЗАПРЕЩЁННЫХ групп из файла
function getBlockedGroups(): Set<number> {
  const configDir = getConfigDirectory();
  const filePath = path.join(configDir, 'blocked_groups.txt');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ids = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => Number(line))
      .filter(id => !isNaN(id));
    Logger.info(`Загружено запрещённых групп: ${ids.length}`);
    return new Set(ids);
  } catch (err) {
    Logger.info('Файл blocked_groups.txt не найден, блокировка не применяется');
    return new Set();
  }
}

export class TelegramAutoPoster {
  private client: TelegramClient;
  private config: Config;
  private groups: GroupInfo[] = [];
  private postingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;
  private slowModeUntil: Map<string, number> = new Map();

  private sessionFile: string;
  private session: StringSession;

  constructor(config: Config) {
    this.config = config;

    const configDir = getConfigDirectory();

    this.sessionFile = path.join(configDir, `session.config`);
    let sessionString = '';

    if (fs.existsSync(this.sessionFile)) {
      try {
        sessionString = fs.readFileSync(this.sessionFile, 'utf-8');
        Logger.info('Loaded existing session from config directory');
      } catch (error) {
        Logger.warn('Failed to load session file, starting fresh');
      }
    }

    this.session = new StringSession(sessionString);

    this.client = new TelegramClient(this.session, config.apiId, config.apiHash, {
      connectionRetries: 5,
    });
  }

  private saveSession(): void {
    try {
      const sessionString = this.session.save() as unknown as string;
      if (sessionString) {
        fs.writeFileSync(this.sessionFile, sessionString, 'utf-8');
      }
    } catch (error) {
      Logger.warn('Failed to save session', error);
    }
  }

  async start(): Promise<void> {
    try {
      Logger.info('Starting Telegram Auto Poster...');
      Logger.info('Connecting to Telegram...');

      await this.client.connect();
      Logger.success('Connected to Telegram');

      if (!(await this.client.checkAuthorization())) {
        Logger.info('Not authorized. Starting authentication...');
        await this.authenticate();
      } else {
        Logger.success('Already authorized');
        this.saveSession();
      }

      Logger.info('Fetching groups...');
      await this.fetchGroups();
      Logger.success(`Found ${this.groups.length} groups`);

      if (this.groups.length === 0) {
        Logger.warn('No groups found. Make sure you are a member of at least one group.');
        return;
      }

      this.isRunning = true;
      Logger.info(
        `Starting parallel posting: will post to groups in batches with concurrency ${process.env.CONCURRENCY || 1}`
      );
      this.startPosting();
      Logger.success('Auto posting started');
    } catch (error) {
      Logger.error('Failed to start bot', error);
      throw error;
    }
  }

  private async authenticate(): Promise<void> {
    try {
      // 1. Получаем номер телефона из переменной окружения или запрашиваем вручную
      let phoneNumber = process.env.PHONE_NUMBER;
      if (!phoneNumber) {
        Logger.info('Please enter your phone number (with country code, e.g., +1234567890):');
        phoneNumber = await this.promptInput('Phone number: ');
      } else {
        Logger.info(`Using phone number from environment: ${phoneNumber}`);
      }

      // 2. Отправляем запрос на код
      const result = await this.client.invoke(
        new Api.auth.SendCode({
          phoneNumber,
          apiId: this.config.apiId,
          apiHash: this.config.apiHash,
          settings: new Api.CodeSettings({}),
        })
      );

      if (!('phoneCodeHash' in result)) {
        throw new Error('Failed to get phone code hash');
      }

      const phoneCodeHash = result.phoneCodeHash;

      // 3. Получаем код из переменной окружения или запрашиваем вручную
      let code = process.env.TELEGRAM_CODE;
      if (!code) {
        Logger.info('Please enter the code you received:');
        code = await this.promptInput('Code: ');
      } else {
        Logger.info(`Using code from environment: ${code}`);
      }

      // 4. Пытаемся войти
      try {
        const signInResult = await this.client.invoke(
          new Api.auth.SignIn({
            phoneNumber,
            phoneCodeHash,
            phoneCode: code,
          })
        );

        if ('user' in signInResult && signInResult.user) {
          const user = signInResult.user;
          let userName = 'User';
          if ('firstName' in user) {
            userName = user.firstName || 'User';
          } else if ('username' in user && user.username) {
            userName = `@${user.username}`;
          }
          Logger.success(`Authentication successful! Logged in as: ${userName}`);
        } else {
          Logger.success('Authentication successful');
        }

        this.saveSession();
      } catch (signInError: any) {
        // Обработка 2FA и других ошибок
        if (
          signInError.errorMessage === 'SESSION_PASSWORD_NEEDED' ||
          (signInError instanceof Error && signInError.message.includes('SESSION_PASSWORD_NEEDED'))
        ) {
          Logger.info('Two-factor authentication is enabled. Please enter your password:');
          const password = await this.promptInput('Password: ');

          const passwordResult = await this.client.invoke(new Api.account.GetPassword());
          const Password = await import('telegram/Password');
          const passwordCheck = await Password.computeCheck(passwordResult, password);

          const checkPasswordResult = await this.client.invoke(
            new Api.auth.CheckPassword({
              password: passwordCheck,
            })
          );

          if ('user' in checkPasswordResult && checkPasswordResult.user) {
            const user = checkPasswordResult.user;
            let userName = 'User';
            if ('firstName' in user) {
              userName = user.firstName || 'User';
            } else if ('username' in user && user.username) {
              userName = `@${user.username}`;
            }
            Logger.success(`Authentication successful! Logged in as: ${userName}`);
          } else {
            Logger.success('Authentication successful');
          }

          this.saveSession();
        } else {
          throw signInError;
        }
      }
    } catch (error) {
      Logger.error('Authentication failed', error);
      throw error;
    }
  }

  private async promptInput(prompt: string): Promise<string> {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise(resolve => {
      readline.question(prompt, (answer: string) => {
        readline.close();
        resolve(answer.trim());
      });
    });
  }

  private async fetchGroups(): Promise<void> {
    try {
      const dialogs = await this.client.getDialogs();
      this.groups = [];

      for (const dialog of dialogs) {
        if (dialog.isGroup || dialog.isChannel) {
          const entity = dialog.entity;
          const dialogId = dialog.id;

          if (entity && dialogId !== undefined && dialogId !== null) {
            let title = 'Unknown';
            if ('title' in entity && entity.title) {
              title = entity.title;
            } else if ('username' in entity && entity.username) {
              title = `@${entity.username}`;
            } else if ('firstName' in entity && entity.firstName) {
              title = entity.firstName;
            }

            const groupId = dialogId.toString();
            this.groups.push({
              id: groupId,
              title,
              entity,
            });
            Logger.info(`Found group: ${title} (ID: ${groupId})`);
          }
        }
      }
    } catch (error) {
      Logger.error('Failed to fetch groups', error);
      throw error;
    }
  }

  private startPosting(): void {
    this.postSequentially();
  }

  // Новый метод с параллельной отправкой
  private async postSequentially(): Promise<void> {
    // Читаем количество параллельных отправок из переменной окружения (по умолчанию 1)
    const concurrency = parseInt(process.env.CONCURRENCY || '1', 10);
    Logger.info(`Параллельных отправок: ${concurrency}`);

    let currentIndex = 0;

    while (this.isRunning) {
      if (this.groups.length === 0) break;

      // Формируем батч групп для параллельной отправки
      const batch: GroupInfo[] = [];
      for (let i = 0; i < concurrency && i < this.groups.length; i++) {
        const idx = (currentIndex + i) % this.groups.length;
        batch.push(this.groups[idx]);
      }

      // Фильтруем группы по чёрному списку и slow mode
      const filteredBatch = batch.filter(group => {
        const blocked = getBlockedGroups();
        if (blocked.size > 0 && blocked.has(Number(group.id))) {
          Logger.info(`Группа "${group.title}" в ЧЁРНОМ списке, пропускаем`);
          return false;
        }
        const blockedUntil = this.slowModeUntil.get(group.id);
        if (blockedUntil && blockedUntil > Date.now()) {
          const remaining = Math.ceil((blockedUntil - Date.now()) / 1000);
          Logger.info(`Группа "${group.title}" заблокирована slow mode ещё ${remaining}с, пропускаем`);
          return false;
        } else if (blockedUntil) {
          this.slowModeUntil.delete(group.id);
        }
        return true;
      });

      if (filteredBatch.length === 0) {
        // Если все группы отфильтрованы, переходим к следующим
        currentIndex = (currentIndex + concurrency) % this.groups.length;
        continue;
      }

      // Запускаем параллельную отправку с небольшой задержкой между стартами (чтобы не выглядеть роботом)
      const startTime = Date.now();
      const promises = filteredBatch.map(async (group, index) => {
        // Искусственная задержка перед отправкой, чтобы разнести по времени
        const delay = index * 2000; // 2 секунды между стартами отправок
        await this.sleep(delay);
        try {
          await this.postToGroup(group);
          Logger.info(`✅ Успешно отправлено в "${group.title}"`);
        } catch (error) {
          Logger.error(`❌ Ошибка отправки в "${group.title}"`, error);
        }
      });

      // Ждём завершения всех отправок в батче
      await Promise.all(promises);

      // Сдвигаем указатель на concurrency групп вперёд
      currentIndex = (currentIndex + concurrency) % this.groups.length;

      // Общая пауза между батчами (5 минут + случайная)
      if (this.isRunning) {
        const randomVariation = Math.floor(Math.random() * 30000) + 20000;
        const totalWaitTime = this.config.postIntervalMs + randomVariation;
        Logger.info(`Ожидание ${(totalWaitTime / 1000).toFixed(1)}с перед следующим батчем`);
        await this.sleep(totalWaitTime);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async postToGroup(group: GroupInfo): Promise<void> {
    Logger.info(`Posting to group: ${group.title} (ID: ${group.id})`);

    if (group.lastMessageId) {
      try {
        await this.client.deleteMessages(group.entity, [group.lastMessageId], {
          revoke: false,
        });
        Logger.info(`Deleted previous message in "${group.title}"`);
      } catch (error) {
        Logger.warn(
          `Failed to delete previous message in "${group.title}":`,
          error instanceof Error ? error.message : error
        );
      }
    }

    try {
      const sentMessage = await this.client.sendMessage(group.entity, {
        message: this.config.message,
      });

      if (!sentMessage) {
        throw new Error(`Failed to send message to "${group.title}" - no response from Telegram`);
      }

      let messageId: number | undefined;
      if (Array.isArray(sentMessage)) {
        messageId = sentMessage[0]?.id;
      } else if (typeof sentMessage === 'object' && 'id' in sentMessage) {
        messageId = sentMessage.id as number;
      }

      if (messageId) {
        group.lastMessageId = messageId;
        Logger.success(`Posted message to "${group.title}" (Message ID: ${messageId})`);
      } else {
        Logger.warn(`Posted to "${group.title}" but couldn't get message ID`);
      }
    } catch (error: any) {
      if (
        error &&
        error.errorMessage &&
        typeof error.errorMessage === 'string' &&
        error.errorMessage.includes('A wait of')
      ) {
        const match = error.errorMessage.match(/wait of (\d+) seconds/);
        if (match) {
          const seconds = parseInt(match[1], 10);
          const until = Date.now() + seconds * 1000;
          this.slowModeUntil.set(group.id, until);
          Logger.warn(
            `Slow mode в группе "${group.title}" — ожидание ${seconds}с, блокируем до ${new Date(until).toLocaleTimeString()}`
          );
        }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    Logger.info('Stopping auto poster...');
    this.isRunning = false;

    for (const interval of this.postingIntervals.values()) {
      clearInterval(interval);
    }
    this.postingIntervals.clear();

    if (this.client.connected) {
      await this.client.disconnect();
      Logger.success('Disconnected from Telegram');
    }
  }
}