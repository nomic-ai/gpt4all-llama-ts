import { exec, spawn, ChildProcessByStdio } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { existsSync, createWriteStream } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import { get } from 'node:https';
import { IncomingMessage } from 'node:http';
import ProgressBar from 'progress';
import { GPTArguments } from './types';

/*
  allowed models:
    Linux: cd chat;./gpt4all-lora-quantized-linux-x86
    Windows (PowerShell): cd chat;./gpt4all-lora-quantized-win64.exe
    M1 Mac/OSX: cd chat;./gpt4all-lora-quantized-OSX-m1
    Intel Mac/OSX: cd chat;./gpt4all-lora-quantized-OSX-intel
*/
const availableModels = [
    'gpt4all-lora-quantized',
    // 'gpt4all-lora-unfiltered-quantized',
] as const;
const MODEL_URL_BASE = 'https://github.com/nomic-ai/gpt4all/blob/main/chat/';

export type AvailableModels = (typeof availableModels)[number];

export class GPT4All {
    private bot: ChildProcessByStdio<Writable, Readable, null> | null = null;
    private model: AvailableModels;
    private decoderConfig: Partial<GPTArguments>;
    private executablePath: string;
    private modelPath: string;
    private downloadPromises: Promise<void>[] | null = null;

    constructor(
        model: AvailableModels = 'gpt4all-lora-quantized',
        forceDownload: boolean = false,
        decoderConfig: Partial<GPTArguments> = {},
    ) {
        this.model = model;
        this.decoderConfig = decoderConfig;
        if (!availableModels.includes(model as AvailableModels)) {
            throw new Error(
                `Model ${model} is not supported. Current models supported are:\n${availableModels.join(
                    ',\n',
                )}`,
            );
        }

        this.executablePath = `${os.homedir()}/.nomic/gpt4all`;
        this.modelPath = `${os.homedir()}/.nomic/${model}.bin`;
        if (forceDownload) this.init(forceDownload);
    }

    async init(forceDownload: boolean = false): Promise<void | void[]> {
        if (this.downloadPromises) return Promise.all(this.downloadPromises);
        const downloadPromises: Promise<void>[] = [];

        if (forceDownload || !existsSync(this.executablePath)) {
            downloadPromises.push(this.downloadExecutable());
        }

        if (forceDownload || !existsSync(this.modelPath)) {
            downloadPromises.push(this.downloadModel());
        }

        return Promise.all(downloadPromises);
    }

    public async open(): Promise<void> {
        this.close();

        let spawnArgs = [this.executablePath, '--model', this.modelPath];

        for (let [key, value] of Object.entries(this.decoderConfig)) {
            spawnArgs.push(`--${key}`, value.toString());
        }

        const bot = spawn(spawnArgs[0], spawnArgs.slice(1), {
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        this.bot = bot;

        // wait for the bot to be ready
        await new Promise((resolve) => {
            const startupListener = (data: Buffer) => {
                if (!data.toString().includes('>')) return;
                resolve(true);
                bot.stdout.removeListener('data', startupListener);
            };
            bot.stdout.addListener('data', startupListener);
        });
    }

    public close(): void {
        if (this.bot === null) return;
        this.bot.kill();
        this.bot = null;
    }

    private async downloadExecutable(): Promise<void> {
        const upstream = await getModelUrl(this.model);

        await this.downloadFile(upstream, this.executablePath);

        await chmod(this.executablePath, 0o755);

        console.log(`File downloaded successfully to ${this.executablePath}`);
    }

    private async downloadModel(): Promise<void> {
        const modelUrl = `https://the-eye.eu/public/AI/models/nomic-ai/gpt4all/${this.model}.bin`;

        await this.downloadFile(modelUrl, this.modelPath);

        console.log(`File downloaded successfully to ${this.modelPath}`);
    }

    private downloadFile(url: string, destination: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            const dir = new URL(`file://${os.homedir()}/.nomic/`);
            await mkdir(dir, { recursive: true });
            const response = await followRedirects(url);

            if (response.statusCode !== 200)
                return reject(response.statusCode || 'Failed to download');
            const totalSize = Number(response.headers['content-length']) || 0;
            if (totalSize === 0)
                return reject(
                    'Failed to download: No download size provided by server',
                );
            const writer = createWriteStream(destination);
            const progressBar = new ProgressBar('[:bar] :percent :etas', {
                complete: '=',
                incomplete: ' ',
                width: 20,
                total: totalSize,
            });
            writer.addListener('finish', resolve);
            writer.addListener('error', reject);
            response.pipe(writer);
            response.addListener('data', (chunk) =>
                progressBar.tick(chunk.length),
            );
        });
    }

    public proompt(prompt: string): Promise<string> {
        return this.prompt(prompt);
    }

    public prompt(prompt: string): Promise<string> {
        const bot = this.bot;
        if (bot === null) {
            throw new Error('Bot is not initialized.');
        }

        bot.stdin.write(prompt + '\n');

        return new Promise((resolve, reject) => {
            let response: string = '';
            let timeoutId: NodeJS.Timeout;

            const onStdoutData = (data: Buffer) => {
                const text = data.toString();
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                if (/^\u{001B}.*\n>\s?/mu.test(text)) {
                    // console.log('Response starts with >, end of message - Resolving...');
                    // Debug log: Indicate that the response ends with "\\f"
                    terminateAndResolve(response); // Remove the trailing "\f" delimiter
                } else {
                    timeoutId = setTimeout(() => {
                        // console.log('Timeout reached - Resolving...');
                        // Debug log: Indicate that the timeout has been reached
                        terminateAndResolve(response);
                    }, 4000); // Set a timeout of 4000ms to wait for more data
                }
                // console.log('Received text:', text);
                // Debug log: Show the received text
                response += text;
                // console.log('Updated response:', response);
                // Debug log: Show the updated response
            };

            const onStdoutError = (err: Error) => {
                bot.stdout.removeListener('data', onStdoutData);
                bot.stdout.removeListener('error', onStdoutError);
                reject(err);
            };

            const terminateAndResolve = (finalResponse: string) => {
                bot.stdout.removeListener('data', onStdoutData);
                bot.stdout.removeListener('error', onStdoutError);
                // check for > at the end and remove it
                if (finalResponse.endsWith('>')) {
                    finalResponse = finalResponse.slice(0, -1);
                }
                resolve(finalResponse);
            };

            bot.stdout.addListener('data', onStdoutData);
            bot.stdout.addListener('error', onStdoutError);
        });
    }
}

const getModelUrl = async (_model: AvailableModels): Promise<string> => {
    const platform = os.platform();
    if (platform === 'linux')
        return MODEL_URL_BASE + 'gpt4all-lora-quantized-linux-x86?raw=true';
    if (platform === 'win32')
        return MODEL_URL_BASE + 'gpt4all-lora-quantized-win64.exe?raw=true';
    if (platform !== 'darwin')
        throw new Error(
            `Your platform is not supported: ${platform}. Current binaries supported are for OSX (ARM and Intel), Linux and Windows.`,
        );
    // check for M1 Mac
    const { stdout } = await promisify(exec)('uname -m');
    if (stdout.trim() === 'arm64')
        return MODEL_URL_BASE + 'gpt4all-lora-quantized-OSX-m1?raw=true';
    return MODEL_URL_BASE + 'gpt4all-lora-quantized-OSX-intel?raw=true';
};

const followRedirects = async (
    url: string | undefined,
): Promise<IncomingMessage> => {
    if (url === undefined) throw new Error('No URL provided');
    const response = await new Promise<IncomingMessage>((res) =>
        get(url, (msg) => res(msg)),
    );
    if (response.statusCode === 301 || response.statusCode === 302)
        return followRedirects(response.headers.location);
    return response;
};
