const {
    VERBOSITY,
    logger, config, helpers,
    convertCurrency, prettyjson,
    InitApp, InitActual, InitBot, LaunchBot
} = require('./init');
const OpenAI = require('openai');

logger.info('Bot is starting up...');

let App = InitApp();
let Actual = InitActual();
let Bot = InitBot();
LaunchBot(Bot);


App.listen(config.PORT, () => {
    logger.info(`Successfully started server on port ${config.PORT}.`);
}).on('error', (err) => {
    logger.error(`Failed to start server. ${err}`);
    process.exit(1);
});

// -- Unified Message Handler --
Bot.on('message', async (ctx) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    const messageText = ctx.message.text || ctx.message.caption;

    logger.info(`Incoming message from user: ${userId}, chat type: ${chatType}`);

    if (messageText) {
        const trimmedText = messageText.trim();

        // Handle /start or /help command
        if (chatType === 'private') {
            if (config.USER_IDS.includes(userId)) {
                if (trimmedText == '/start' || trimmedText == '/help') {
                    logger.debug(`Sending intro message to user ${userId}.`);
                    return ctx.reply(config.INTRO.replace('%USER_ID%', userId));
                } else {
                    await Actual.sync();
                    const categories = await Actual.getCategories();
                    const accounts = await Actual.getAccounts();
                    const payees = await Actual.getPayees();

                    const prompt = config.OPENAI_PROMPT
                        .replace('%DATE%', new Date().toISOString().split('T')[0])
                        .replace('%DEFAULT_ACCOUNT%', config.ACTUAL_DEFAULT_ACCOUNT)
                        .replace('%DEFAULT_CATEGORY%', config.ACTUAL_DEFAULT_CATEGORY)
                        .replace('%CURRENCY%', config.ACTUAL_CURRENCY)
                        .replace('%ACCOUNTS_LIST%', accounts.map(acc => acc.name).join(', '))
                        .replace('%CATEGORY_LIST%', categories.map(cat => cat.name).join(', '))
                        .replace('%PAYEE_LIST%', payees.map(payee => payee.name).join(', '));

                    // CALL THE LLM AND PARSE ITS RESPONSE
                    let parsedResponse = null;
                    try {
                        const openai = new OpenAI({
                            apiKey: config.OPENAI_API_KEY,
                            baseURL: config.OPENAI_API_ENDPOINT,
                        });

                        logger.debug('=== LLM Request Details ===');
                        logger.debug('System Prompt:\n' + prompt);
                        logger.debug(`User Message: ${trimmedText}`);

                        const response = await openai.chat.completions.create({
                            model: config.OPENAI_MODEL,
                            messages: [
                                { role: 'system', content: prompt },
                                { role: 'user', content: trimmedText },
                            ],
                            temperature: config.OPENAI_TEMPERATURE,
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
                        let replyMessage;
                        if (config.BOT_VERBOSITY === VERBOSITY.VERBOSE) {
                            replyMessage = '*[LLM ANSWER]*\n```\n';
                            replyMessage += prettyjson.render(parsedResponse, { noColor: true });
                            replyMessage += '\n```\n\n';
                        }
                        replyMessage += '*[TRANSACTIONS]*\n';
                        let txInfo = {};
                        const transactions = await Promise.all(parsedResponse.map(async (tx) => {
                            if (!tx.account) {
                                tx.account = config.ACTUAL_DEFAULT_ACCOUNT;
                            }
                            if (!tx.category) {
                                tx.category = config.ACTUAL_DEFAULT_CATEGORY;
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

                            if (tx.currency && tx.currency.toLowerCase() !== config.ACTUAL_CURRENCY.toLowerCase()) {
                                amount = await convertCurrency(tx.amount, tx.currency, config.ACTUAL_CURRENCY, apiDate, tx.exchange_rate);
                            } else {
                                tx.currency = config.ACTUAL_CURRENCY;
                            }

                            // Provide human-readable output of processed transaction data
                            replyMessage += '```\n';
                            let humanAmount = `${tx.amount} ${tx.currency}`;
                            if (tx.currency && tx.currency.toLowerCase() !== config.ACTUAL_CURRENCY.toLowerCase()) {
                                humanAmount = `${amount} ${config.ACTUAL_CURRENCY}`;
                            }

                            txInfo = {
                                date,
                                account: account.name,
                                category: category.name,
                                ...(humanAmount && { amount: humanAmount }),
                                ...(tx.payee && { payee: tx.payee }),
                                ...(tx.notes && { notes: tx.notes })
                            };
                            if (config.BOT_VERBOSITY >= VERBOSITY.NORMAL) {
                                replyMessage += prettyjson.render(txInfo, { noColor: true });
                                replyMessage += '```\n';
                            } else {
                                replyMessage = '';
                            }

                            amount = parseFloat((amount * 100).toFixed(2)); // Convert to cents
                            return {
                                account: account.id,
                                date,
                                amount,
                                payee_name: tx.payee || null,
                                category: category.id,
                                notes: `${config.ACTUAL_NOTE_PREFIX} ${tx.notes || ''}`,
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

                        if (config.BOT_VERBOSITY > VERBOSITY.SILENT) {
                            return ctx.reply(replyMessage, { parse_mode: 'Markdown' });
                        }

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

App.post('/webhook', (req, res) => {
    try {
        Bot.handleUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        logger.error('Error handling update:', error);
        res.sendStatus(500);
    }
});

// API endpoint for custom input outside Telegram
App.post('/input', (req, res) => {
    const userAgent = req.headers['user-agent'];
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.socket.remoteAddress;
    logger.debug(`Custom input request received [IP: ${ip}, User-Agent: ${userAgent}]`);
    try {
        const apiKey = req.headers['x-api-key'];

        if (!apiKey || apiKey !== config.INPUT_API_KEY || !config.INPUT_API_KEY || config.INPUT_API_KEY.length < 16) {
            logger.debug('Custom input request denied: invalid API key');
            return res.status(401).send('Unauthorized');
        }

        const { user_id, text } = req.body;

        if (config.USER_IDS.includes(user_id)) {
            Bot.handleUpdate(helpers.createUpdateObject(user_id, text));
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
App.get('/health', (req, res) => {
    res.send('OK');
});