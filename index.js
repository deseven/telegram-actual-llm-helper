require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { Telegraf } = require('telegraf');
const winston = require('winston');
const axios = require('axios');
const OpenAI = require('openai');
const prettyjson = require('prettyjson');
const Actual = require('@actual-app/api');
const h = require('./helpers');

const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

// -- Winston Logger --
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.align(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}]: ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

// Override console methods to use Winston logger
console.log = (...args) => logger.debug(args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

// -- Config --
const BOT_TOKEN = process.env.BOT_TOKEN;
const USE_POLLING = process.env.USE_POLLING === 'true';
let BASE_URL = '';
if (!USE_POLLING) {
    BASE_URL = h.validateAndTrimUrl(process.env.BASE_URL) || (() => {
        logger.error('Invalid or missing BASE_URL. Provide a correct URL in the .env file or set USE_POLLING to true.');
        process.exit(1);
    })();
}
const PORT = parseInt(process.env.PORT, 10) || 5005;
const USER_IDS = (process.env.USER_IDS || '999999999').split(',').map(id => parseInt(id.trim(), 10));
const INPUT_API_KEY = process.env.INPUT_API_KEY || '';
const INTRO_DEFAULT = `This is a private bot that helps with adding transactions to Actual Budget by using ChatGPT or other LLMs.

You can set up your own instance, more info here:
https://github.com/deseven/telegram-actual-llm-helper

Your User ID is %USER_ID%.`;
const INTRO = `Hello! Send me any information about a transaction and I'll try to process it!`;

// -- Actual --
const ACTUAL_API_ENDPOINT = process.env.ACTUAL_API_ENDPOINT;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD;
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID;
const ACTUAL_DATA_DIR = process.env.ACTUAL_DATA_DIR || '/app/data';
const ACTUAL_CURRENCY = process.env.ACTUAL_CURRENCY || 'EUR';
const ACTUAL_DEFAULT_ACCOUNT = process.env.ACTUAL_DEFAULT_ACCOUNT || 'Cash';
const ACTUAL_DEFAULT_CATEGORY = process.env.ACTUAL_DEFAULT_CATEGORY || 'Food';
const ACTUAL_NOTE_PREFIX = process.env.ACTUAL_NOTE_PREFIX || '🤖';

// -- LLM --
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.2;
let OPENAI_PROMPT_PATH = './default.prompt';
let OPENAI_PROMPT = '';

logger.info('Bot is starting up...');

// -- Custom prompt handling --
(() => {
    const custom = './custom.prompt';
    try {
        if (fs.existsSync(custom) && fs.statSync(custom).size > 0) {
            OPENAI_PROMPT_PATH = custom;
        }
    } catch (error) {
        logger.error('Error loading prompt file. ', error);
        process.exit(1);
    }
})();

// -- Display settings on startup --
const envSettings = {
    BOT_TOKEN: h.obfuscate(BOT_TOKEN),
    USE_POLLING,
    BASE_URL,
    PORT,
    LOG_LEVEL,
    USER_IDS,
    INPUT_API_KEY: h.obfuscate(INPUT_API_KEY),
    OPENAI_API_KEY: h.obfuscate(OPENAI_API_KEY),
    OPENAI_API_ENDPOINT,
    OPENAI_MODEL,
    OPENAI_TEMPERATURE,
    OPENAI_PROMPT_PATH,
    ACTUAL_API_ENDPOINT,
    ACTUAL_PASSWORD: h.obfuscate(ACTUAL_PASSWORD),
    ACTUAL_SYNC_ID,
    ACTUAL_CURRENCY,
    ACTUAL_DEFAULT_ACCOUNT,
    ACTUAL_DEFAULT_CATEGORY,
    ACTUAL_DATA_DIR,
    ACTUAL_NOTE_PREFIX
};
logger.info(`=== Startup Settings ===\n${prettyjson.render(envSettings, { noColor: true })}`);

logger.debug(`Loading prompt from ${OPENAI_PROMPT_PATH}...`);
try {
    OPENAI_PROMPT = fs.readFileSync(OPENAI_PROMPT_PATH, 'utf8').trim();
} catch (err) {
    logger.error(`Failed to load prompt from ${OPENAI_PROMPT_PATH}. ${err}`);
    process.exit(1);
}

if (BASE_URL && INPUT_API_KEY.length < 16) {
    logger.warn('For security reasons INPUT_API_KEY must be at least 16 characters long, /input will be disabled.');
}

// -- Initialize the Telegraf Bot --
const bot = new Telegraf(BOT_TOKEN);

// -- Initialize Actual API --
async function initActual() {
    try {
        if (!fs.existsSync(ACTUAL_DATA_DIR)) {
            logger.info(`Creating data directory: ${ACTUAL_DATA_DIR}`);
            fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
        }

        await Actual.init({
            dataDir: ACTUAL_DATA_DIR,
            serverURL: ACTUAL_API_ENDPOINT,
            password: ACTUAL_PASSWORD,
        });

        logger.debug('Downloading budget...');
        await Actual.downloadBudget(ACTUAL_SYNC_ID);

        logger.debug('Checking default account and category...');
        let categories = await Actual.getCategories();
        let accounts = await Actual.getAccounts();
        let account = accounts.find(acc => acc.name === ACTUAL_DEFAULT_ACCOUNT)
        let category = categories.find(cat => cat.name === ACTUAL_DEFAULT_CATEGORY);
        if (!account || !category) {
            throw new Error('Could not find default account or category, check your configuration.');
        }
        logger.info('Successfully connected to Actual Budget.');
    } catch (error) {
        logger.error('Error connecting to Actual Budget:', error);
        process.exit(1);
    }
}

// -- Currency Conversion --
async function convertCurrency(amount, fromCurrency, toCurrency, apiDate, rate = undefined) {
    if (fromCurrency.toLowerCase() === toCurrency.toLowerCase()) {
        return parseFloat(amount.toFixed(2));
    }

    if (rate !== undefined) {
        logger.debug(`Using provided rate: ${rate} for conversion from ${fromCurrency} to ${toCurrency}`);
        const convertedAmount = amount * rate;
        return parseFloat(convertedAmount.toFixed(2));
    }

    const apiUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${apiDate}/v1/currencies/${fromCurrency.toLowerCase()}.json`;
    logger.debug(`Fetching currency conversion from ${apiUrl}`);
    try {
        const response = await axios.get(apiUrl);
        const rates = response.data[fromCurrency.toLowerCase()];
        if (!rates || !rates[toCurrency.toLowerCase()]) {
            throw new Error(`Currency conversion rate not found for ${fromCurrency} to ${toCurrency}`);
        }
        const convertedAmount = amount * rates[toCurrency.toLowerCase()];
        return parseFloat(convertedAmount.toFixed(2));
    } catch (error) {
        logger.error('Error converting currency:', error);
        throw new Error('Failed to convert currency');
    }
}

// -- Unified Message Handler --
bot.on('message', async (ctx) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    const messageText = ctx.message.text || ctx.message.caption;

    logger.info(`Incoming message from user: ${userId}, chat type: ${chatType}`);

    if (messageText) {
        const trimmedText = messageText.trim();

        // Handle /start or /help command
        if (chatType === 'private') {
            if (USER_IDS.includes(userId)) {
                if (trimmedText == '/start' || trimmedText == '/help') {
                    logger.debug(`Sending intro message to user ${userId}.`);
                    return ctx.reply(INTRO.replace('%USER_ID%', userId));
                } else {
                    await Actual.sync();
                    const categories = await Actual.getCategories();
                    const accounts = await Actual.getAccounts();
                    const payees = await Actual.getPayees();

                    const prompt = OPENAI_PROMPT
                        .replace('%DATE%', new Date().toISOString().split('T')[0])
                        .replace('%DEFAULT_ACCOUNT%', ACTUAL_DEFAULT_ACCOUNT)
                        .replace('%DEFAULT_CATEGORY%', ACTUAL_DEFAULT_CATEGORY)
                        .replace('%CURRENCY%', ACTUAL_CURRENCY)
                        .replace('%ACCOUNTS_LIST%', accounts.map(acc => acc.name).join(', '))
                        .replace('%CATEGORY_LIST%', categories.map(cat => cat.name).join(', '))
                        .replace('%PAYEE_LIST%', payees.map(payee => payee.name).join(', '));

                    // CALL THE LLM AND PARSE ITS RESPONSE
                    let parsedResponse = null;
                    try {
                        const openai = new OpenAI({
                            apiKey: OPENAI_API_KEY,
                            baseURL: OPENAI_API_ENDPOINT,
                        });

                        logger.debug('=== LLM Request Details ===');
                        logger.debug('System Prompt:\n' + prompt);
                        logger.debug(`User Message: ${trimmedText}`);

                        const response = await openai.chat.completions.create({
                            model: OPENAI_MODEL,
                            messages: [
                                { role: 'system', content: prompt },
                                { role: 'user', content: trimmedText },
                            ],
                            temperature: OPENAI_TEMPERATURE,
                        });

                        // Remove possible Markdown fences
                        const jsonResponse = response.choices[0].message.content
                            .replace(/```(?:json)?\n?|\n?```/g, '')
                            .trim();

                        logger.debug('=== LLM Response ===');
                        logger.debug(jsonResponse);

                        parsedResponse = JSON.parse(jsonResponse);

                        if (!Array.isArray(parsedResponse)) {
                            throw new Error('LLM response is not an array');
                        }

                        if (parsedResponse.length === 0) {
                            return ctx.reply('Failed to find any information to create transactions. Try again?');
                        }
                    } catch (err) {
                        logger.error('Error obtaining/parsing LLM response:', err);
                        return ctx.reply('Sorry, I received an invalid or empty response from the LLM. Check the bot logs.');
                    }

                    // CREATE TRANSACTIONS IN ACTUAL
                    try {
                        let replyMessage = '*[TRANSACTIONS]*\n';
                        let txInfo = {};
                        const transactions = await Promise.all(parsedResponse.map(async (tx) => {
                            if (!tx.account) {
                                tx.account = ACTUAL_DEFAULT_ACCOUNT;
                            }
                            if (!tx.category) {
                                tx.category = ACTUAL_DEFAULT_CATEGORY;
                            }
                            const account = accounts.find(acc => acc.name === tx.account);
                            const category = categories.find(cat => cat.name === tx.category);
                            const payee = payees.find(p => p.name === tx.payee);

                            if (!account) {
                                throw new Error(`Invalid account specified: "${tx.account}"`);
                            }
                            if (!category) {
                                throw new Error(`Invalid category specified: "${tx.category}"`);
                            }

                            let date = tx.date || new Date().toISOString().split('T')[0];
                            let apiDate = date;
                            let amount = tx.amount;

                            // If date is today, currency API may not have today's data yet due to timezone differences
                            if (date === new Date().toISOString().split('T')[0]) {
                                apiDate = 'latest';
                            }

                            if (tx.currency && tx.currency.toLowerCase() !== ACTUAL_CURRENCY.toLowerCase()) {
                                amount = await convertCurrency(tx.amount, tx.currency, ACTUAL_CURRENCY, apiDate, tx.exchange_rate);
                            } else {
                                tx.currency = ACTUAL_CURRENCY;
                            }

                            // Provide human-readable output of processed transaction data
                            replyMessage += '```\n';
                            let humanAmount = `${tx.amount} ${tx.currency}`;
                            let humanConvertedAmount = '';
                            if (tx.currency && tx.currency.toLowerCase() !== ACTUAL_CURRENCY.toLowerCase()) {
                                humanConvertedAmount = `${amount} ${ACTUAL_CURRENCY}`;
                            }

                            txInfo = {
                                date,
                                account: account.name,
                                category: category.name,
                                ...(humanAmount && { amount: humanAmount }),
                                ...(humanConvertedAmount && { converted: humanConvertedAmount }),
                                ...(tx.payee && { payee: tx.payee }),
                                ...(tx.notes && { notes: tx.notes })
                            };
                            replyMessage += prettyjson.render(txInfo, { noColor: true });
                            replyMessage += '```\n';

                            amount = parseFloat((amount * 100).toFixed(2)); // Convert to cents
                            return {
                                account: account.id,
                                date,
                                amount,
                                payee_name: tx.payee || null,
                                category: category.id,
                                notes: `${ACTUAL_NOTE_PREFIX} ${tx.notes || ''}`,
                            };
                        }));

                        // Group transactions by account
                        const transactionsByAccount = transactions.reduce((acc, tx) => {
                            if (!acc[tx.account]) {
                                acc[tx.account] = [];
                            }
                            acc[tx.account].push(tx);
                            return acc;
                        }, {});

                        let added = 0;

                        for (const [accountId, accountTxs] of Object.entries(transactionsByAccount)) {
                            const transactionsText = accountTxs.map(tx =>
                                `Account: ${tx.account}, Date: ${tx.date}, Amount: ${tx.amount}, Payee: ${tx.payee_name}, Category: ${tx.category}, Notes: ${tx.notes}`
                            ).join('\n');
                            logger.info(`Importing transactions for account ${accountId}:\n${transactionsText}`);

                            const result = await Actual.addTransactions(accountId, accountTxs);
                            if (result) {
                                added += accountTxs.length;
                            }
                        }

                        replyMessage += '\n*[ACTUAL]*\n';
                        if (!added) {
                            replyMessage += 'no changes';
                        } else {
                            replyMessage += `added: ${added}`;
                            await Actual.sync();
                        }
                        logger.info(`Added ${added} transactions to Actual Budget.`);

                        return ctx.reply(replyMessage, { parse_mode: 'Markdown' });

                    } catch (err) {
                        logger.error('Error creating transactions in Actual Budget:', err);

                        if (err.message && err.message.includes('convert currency')) {
                            return ctx.reply('Sorry, there was an error converting the currency. Check the bot logs.');
                        }
                        return ctx.reply('Sorry, I encountered an error creating the transaction(s). Check the bot logs.');
                    }
                }
            } else {
                return ctx.reply(INTRO_DEFAULT);
            }
        }
    }
});

// -- Error handling --
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception thrown:', err);
    process.exit(1);
});

bot.catch((err, ctx) => {
    logger.error('Global Telegraf error:', err);
});

// Create Express app
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
    try {
        bot.handleUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        logger.error('Error handling update:', error);
        res.sendStatus(500);
    }
});

// API endpoint for custom input outside Telegram
app.post('/input', (req, res) => {
    const userAgent = req.headers['user-agent'];
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.socket.remoteAddress;
    logger.debug(`Custom input request received [IP: ${ip}, User-Agent: ${userAgent}]`);
    try {
        const apiKey = req.headers['x-api-key'];

        if (!apiKey || apiKey !== INPUT_API_KEY || !INPUT_API_KEY || INPUT_API_KEY.length < 16) {
            logger.debug('Custom input request denied: invalid API key');
            return res.status(401).send('Unauthorized');
        }

        const { user_id, text } = req.body;

        if (USER_IDS.includes(user_id)) {
            bot.handleUpdate(h.createUpdateObject(user_id, text));
            logger.debug('Custom input request handled successfully.');
            return res.json({ status: 'OK' });
        } else {
            logger.debug('Custom input request denied: invalid user ID');
            return res.status(403).send('Forbidden');
        }

    } catch (error) {
        logger.error('Error handling custom input request. ', error);
        return res.status(500).json({ error: 'Failed to handle message' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    logger.debug('Health ping.');
    res.send('OK');
});

// Start the server
app.listen(PORT, () => {
    startBot().catch(err => {
        logger.error('Error starting bot:', err);
        process.exit(1);
    });
});

async function startBot() {
    await initActual();

    if (USE_POLLING) {
        logger.debug('Attempting to delete any existing webhook before polling...');
        try {
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            logger.debug('Webhook deleted successfully');
        } catch (err) {
            logger.warn(`deleteWebhook failed: ${err}`);
        }

        try {
            bot.launch();
            logger.debug('Polling enabled!');
        } catch (err) {
            logger.error('Error launching bot with polling:', err);
            process.exit(1);
        }
    } else {
        logger.debug('Setting webhook...');
        try {
            await bot.telegram.setWebhook(`${BASE_URL}/webhook`);
            logger.debug(`Webhook set: ${BASE_URL}/webhook`);
        } catch (err) {
            logger.error('Error setting webhook:', err);
            process.exit(1);
        }
    }

    logger.info('Bot started successfully!');
}