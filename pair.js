// SUBZERO MD MINI 2
// Main pairing / bot management router with MongoDB
require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const FileType = require('file-type');
const FormData = require('form-data');
const os = require('os');
const QRCode = require('qrcode');
const yts = require('yt-search');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const config = require('./config');

// MongoDB Connection
const connectMongoDB = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        console.log('✅ Connected to MongoDB successfully');
        
        // Create indexes for better performance
        await mongoose.connection.db.collection('sessions').createIndex({ number: 1 }, { unique: true });
        await mongoose.connection.db.collection('sessions').createIndex({ updatedAt: 1 });
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        process.exit(1);
    }
};

// Call MongoDB connection on startup
connectMongoDB();

// Session Schema
const sessionSchema = new mongoose.Schema({
    number: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true,
        match: /^\d+$/
    },
    creds: { 
        type: mongoose.Schema.Types.Mixed, 
        required: true 
    },
    config: { 
        type: mongoose.Schema.Types.Mixed, 
        default: {} 
    },
    lastActive: { 
        type: Date, 
        default: Date.now 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Update timestamp before saving
sessionSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Session = mongoose.model('Session', sessionSchema);

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = config.SESSION_BASE_PATH;
const NUMBER_LIST_PATH = config.NUMBER_LIST_PATH;
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    // No need for this with MongoDB - automatic deduplication
    console.log(`Session management for ${number} handled by MongoDB`);
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9-_]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
        
        //==========
    const caption = formatMessage(
        `╭──▧  Subzero Mini Info :
│ » ✅ Successfully connected!
│ » 🔢 Number: ${number}
│ » 🍁 Channel: followed.
│ » 🎀 Type ${config.PREFIX}menu for commands
└────────────···
> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in ${Math.floor(config.OTP_EXPIRY / 60000)} minutes.`,
        '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['✨', '🔥', '🎀', '👍', '❤️'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message || err);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message || error);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ 𝘿𝙀𝙇𝙀𝙏𝙀𝘿 𝙈𝙀𝙎𝙎𝘼𝙂𝙀 𝘼𝙇𝙀𝙍𝙏',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈 '
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
        try {
            const akuru = sender;
            const quot = msg;
            if (quot) {
                if (quot.imageMessage?.viewOnce) {
                    let cap = quot.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.videoMessage?.viewOnce) {
                    let cap = quot.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.audioMessage?.viewOnce) {
                    let cap = quot.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.imageMessage){
                    let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.videoMessage){
                    let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
                    let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                }
            }        
        } catch (error) {
            console.error('oneViewmeg error:', error);
        }
    }
}

function setupCommandHandlers(socket, number) {
    // Contact message for verified context (used as quoted message)
   /* const verifiedContact = {
        key: {
            fromMe: false,
            participant: `0@s.whatsapp.net`,
            remoteJid: "status@broadcast"
        },
        message: {
            contactMessage: {
                displayName: "VERONICA AI",
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN: Tᴇʀʀɪ 🧚‍♀️\nORG:Vᴇʀᴏɴɪᴄᴀ BOT;\nTEL;type=CELL;type=VOICE;waid=93775551335:+256784670936\nEND:VCARD"
            }
        }
    };
    */
    
  // Create the AI message structure
        const verifiedContact = {
            key: {
                remoteJid: "status@broadcast",
                fromMe: false,
                participant: "13135550002@s.whatsapp.net"
            },
            message: {
                contactMessage: {
                    displayName: "© 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃",
                    vcard: `BEGIN:VCARD
VERSION:3.0
FN:Meta AI
TEL;type=CELL;type=VOICE;waid=13135550002:+1 3135550002
END:VCARD`
                }
            }
        };  
        // Create the AI message structure
        const ai = {
            key: {
                remoteJid: "status@broadcast",
                fromMe: false,
                participant: "13135550002@s.whatsapp.net"
            },
            message: {
                contactMessage: {
                    displayName: "© 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃",
                    vcard: `BEGIN:VCARD
VERSION:3.0
FN:Meta AI
TEL;type=CELL;type=VOICE;waid=13135550002:+1 3135550002
END:VCARD`
                }
            }
        };

    // Anti-call system - per user configuration
    const recentCallers = new Set();
    socket.ev.on("call", async (callData) => {
        try {
            const sanitizedNumber = number.replace(/[^0-9]/g, '');
            const userConfig = await loadUserConfig(sanitizedNumber);
            
            if (userConfig.ANTICALL !== 'true') {
                console.log(`📞 Anti-call is disabled for ${sanitizedNumber}, ignoring call`);
                return;
            }

            const calls = Array.isArray(callData) ? callData : [callData];
            
            for (const call of calls) {
                if (call.status === "offer" && !call.fromMe) {
                    console.log(`📵 Incoming call from: ${call.from} to ${sanitizedNumber}`);
                    
                    try {
                        await socket.rejectCall(call.id, call.from);
                        console.log('✅ Call rejected');
                    } catch (e) {
                        console.log('⚠️ Could not reject call (might be already ended):', e.message);
                    }

                    if (!recentCallers.has(call.from)) {
                        recentCallers.add(call.from);
                        
                        try {
                            await socket.sendMessage(call.from, {
                                text: `*📵 Call Rejected Automatically!*\n\n*Owner is busy, please do not call!* ⚠️\n\nSend a message instead for faster response.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                            });
                            console.log('📩 Warning message sent');
                        } catch (msgError) {
                            console.log('⚠️ Could not send warning message:', msgError.message);
                        }

                        setTimeout(() => {
                            recentCallers.delete(call.from);
                            console.log(`🔄 Cleared caller from recent list: ${call.from}`);
                        }, 10 * 60 * 1000);
                    } else {
                        console.log('⚠️ Already sent warning to this caller recently');
                    }
                }
            }
        } catch (error) {
            console.error('❌ Anti-call system error:', error.message);
        }
    });

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
            ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
            : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
            ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
            ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
            ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
            ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
            ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
            ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
            ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                || msg.text) 
            : (type === 'viewOnceMessage') 
            ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
            ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        
        // Load user-configured prefix dynamically
        const userConfig = await loadUserConfig(sanitizedNumber);
        var prefix = userConfig.PREFIX || config.PREFIX;
        var isCmd = (body || '').startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = (body || '').trim().split(/ +/).slice(1);

        // Check if user is admin in group
        let isAdmins = false;
        let isBotAdmin = false;
        let groupMetadata = null;
        if (isGroup) {
            try {
                groupMetadata = await socket.groupMetadata(from);
                const participants = groupMetadata.participants;
                const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                
                // Check if sender is admin - compare full JID
                const senderObj = participants.find(p => p.id === nowsender);
                isAdmins = senderObj?.admin === 'admin' || senderObj?.admin === 'superadmin' || isOwner;
                
                // Check if bot is admin
                const botObj = participants.find(p => p.id === botJid);
                isBotAdmin = botObj?.admin === 'admin' || botObj?.admin === 'superadmin';
            } catch (error) {
                console.error('Failed to fetch group metadata:', error);
            }
        }

        socket.downloadAndSaveMediaMessage = async(message, filename = (Date.now()).toString(), attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            const trueFileName = attachExtension ? (filename + '.' + (type ? type.ext : 'bin')) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        }

        // Handle prefix change
        if (global.pendingPrefixChange && global.pendingPrefixChange.has(nowsender)) {
            const prefixData = global.pendingPrefixChange.get(nowsender);
            if (Date.now() - prefixData.timestamp < 60000) {
                const newPrefix = body.trim();
                if (newPrefix.length === 1 || newPrefix.length === 2) {
                    const userConfig = await loadUserConfig(prefixData.number);
                    userConfig.PREFIX = newPrefix;
                    await updateUserConfig(prefixData.number, userConfig);
                    await socket.sendMessage(sender, {
                        text: `✅ *Prefix Changed*\n\nNew prefix: *${newPrefix}*\n\nExample: ${newPrefix}menu\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                    }, { quoted: msg });
                    global.pendingPrefixChange.delete(nowsender);
                    return;
                } else {
                    await socket.sendMessage(sender, {
                        text: `❌ Invalid prefix. Must be 1-2 characters.\n\nTry again with ${prefix}settings`
                    }, { quoted: msg });
                    global.pendingPrefixChange.delete(nowsender);
                    return;
                }
            } else {
                global.pendingPrefixChange.delete(nowsender);
            }
        }

        if (!command) return;

        // Check private mode and sudo access (userConfig already loaded above for prefix)
        const botMode = userConfig.MODE || config.MODE;
        
        if (botMode === 'private' && !isOwner) {
            // Check if user is sudo
            let sudoUsers = [];
            try {
                sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
            } catch {}
            
            // Bot number is always owner
            const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            const isBotOwner = nowsender === botOwnerJid;
            const isSudoUser = sudoUsers.includes(nowsender);
            
            if (!isBotOwner && !isSudoUser) {
                // Silently ignore commands in private mode from non-sudo users
                return;
            }
        }

        try {
            switch (command) {
              //==============================
              case 'button': {
const buttons = [
    {
        buttonId: 'button1',
        buttonText: { displayText: 'Button 1' },
        type: 1
    },
    {
        buttonId: 'button2',
        buttonText: { displayText: 'Button 2' },
        type: 1
    }
];

const captionText = 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴍʀ ғʀᴀɴᴋ';
const footerText = 'sᴜʙᴢᴇʀᴏ ᴍᴅ ᴍɪɴɪ';

const buttonMessage = {
    image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
    caption: captionText,
    footer: footerText,
    buttons,
    headerType: 1
};

socket.sendMessage(from, buttonMessage, { quoted: msg });

    break;
}

//==============================                                
case 'ping':
case 'speed':
case 'pong': {
    try {
        const start = Date.now();
        
        

        // Send initial message with AI quoted style
        await socket.sendMessage(from, {
            text: "```Testing latency...⌛️```",
            contextInfo: {
                quotedMessage: ai.message,
                mentionedJid: [msg.key.participant || msg.key.remoteJid],
                forwardingScore: 999,
                isForwarded: true
            }
        }, { quoted: ai });

        const speed = Date.now() - start;
        
        // Send result with AI quoted style
        await socket.sendMessage(from, {
            text: `\`\`\`Pong ${speed}ms\`\`\`\n\n*🤖 Bot Status:*\n• Response Time: ${speed}ms\n• Active Sessions: ${activeSockets.size}\n• Uptime: ${Math.floor((Date.now() - (socketCreationTime.get(number) || Date.now())) / 1000)}s`,
            contextInfo: {
                quotedMessage: ai.message,
                mentionedJid: [msg.key.participant || msg.key.remoteJid],
                forwardingScore: 999,
                isForwarded: true
            }
        }, { quoted: ai });

    } catch (e) {
        console.error("Ping command error:", e);
        await socket.sendMessage(from, {
            text: `❌ Error: ${e.message}`,
            contextInfo: {
                quotedMessage: {
                    conversation: "Error occurred while processing ping command"
                },
                mentionedJid: [msg.key.participant || msg.key.remoteJid]
            }
        }, { quoted: msg });
    }
    break;
}
//###########

              
// ==================== APK DOWNLOADER ====================
case 'apk':
case 'modapk':
case 'apkdownload': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: 'Please provide an app name. Example: `.apk islam360`'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Prepare the NexOracle API URL
        const apiUrl = `https://api.nexoracle.com/downloader/apk`;
        const params = {
            apikey: 'free_key@maher_apis',
            q: q.trim()
        };

        // Call the NexOracle API
        const response = await axios.get(apiUrl, { params, timeout: 15000 });

        // Check if the API response is valid
        if (!response.data || response.data.status !== 200 || !response.data.result) {
            throw new Error('Unable to find the APK');
        }

        // Extract the APK details
        const { name, lastup, package: pkg, size, icon, dllink } = response.data.result;

        // Send app info with thumbnail
        await socket.sendMessage(sender, {
            image: { url: icon },
            caption: `📦 *Downloading ${name}... Please wait.*`
        }, { quoted: msg });

        // Download the APK file
        const apkResponse = await axios.get(dllink, { 
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        if (!apkResponse.data) {
            throw new Error('Failed to download the APK');
        }

        const apkBuffer = Buffer.from(apkResponse.data, 'binary');

        // Prepare the message with APK details
        const message = `📦 *APK Details:*\n\n` +
          `🔖 *Name:* ${name}\n` +
          `📅 *Last Updated:* ${lastup}\n` +
          `📦 *Package:* ${pkg}\n` +
          `📏 *Size:* ${size}\n\n` +
          `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Send the APK file as a document
        await socket.sendMessage(sender, {
            document: apkBuffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name}.apk`,
            caption: message
        }, { quoted: msg });

        // Send success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('APK Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Unable to fetch APK details'}`
        }, { quoted: msg });
    }
    break;
}
// ==================== ANIME VIDEO COMMAND ====================
case 'anime':
case 'animevideo':
case 'animevid': {
    try {
        const cheerio = require('cheerio');
        
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        async function animeVideo() {
            const url = 'https://shortstatusvideos.com/anime-video-status-download/'; 
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            const $ = cheerio.load(response.data);
            const videos = [];
            
            $('a.mks_button.mks_button_small.squared').each((index, element) => {
                const href = $(element).attr('href');
                const title = $(element).closest('p').prevAll('p').find('strong').text();
                if (href && title) {
                    videos.push({
                        title: title.trim(),
                        source: href
                    });
                }
            });

            if (videos.length === 0) {
                throw new Error('No videos found');
            }

            const randomIndex = Math.floor(Math.random() * videos.length);
            return videos[randomIndex];
        }

        const randomVideo = await animeVideo();
        
        // Download the video
        const videoResponse = await axios.get(randomVideo.source, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const videoBuffer = Buffer.from(videoResponse.data, 'binary');
        
        // Send the video
        await socket.sendMessage(sender, {
            video: videoBuffer,
            caption: `🎌 *ANIME VIDEO*\n\n` +
                    `📺 *Title:* ${randomVideo.title || 'Random Anime Video'}\n` +
                    `🔗 *Source:* ${randomVideo.source}\n\n` +
                    `> Powered by Subzero MD`
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('Anime video command error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: '❌ Failed to fetch anime video. Please try again later.'
        }, { quoted: msg });
    }
    break;
}

// ==================== MEDIAFIRE DOWNLOAD COMMAND ====================
case 'mediafire':
case 'mf':
case 'mfire': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a MediaFire link. Example: `.mediafire https://www.mediafire.com/file/...`'
            }, { quoted: msg });
        }

        const url = q.trim();
        if (!url.includes('mediafire.com')) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a valid MediaFire link.'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        async function mediafireDownload(mfUrl) {
            return new Promise(async (resolve, reject) => {
                try {
                    const response = await axios.get(mfUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                    const $ = cheerio.load(response.data);

                    // Extract file information
                    const filename = $('.dl-btn-label').attr('title') || 
                                    $('div.filename').text().trim() ||
                                    'Unknown_File';
                    
                    const size = $('.file-size').text().trim() || 
                                $('.details > div:contains("Size")').text().replace('Size', '').trim() ||
                                'Unknown size';
                    
                    const downloadUrl = $('.input').attr('href') || 
                                      $('.downloadButton').attr('href') ||
                                      $('a#downloadButton').attr('href');

                    if (!downloadUrl) {
                        throw new Error('Download link not found');
                    }

                    resolve({
                        filename: filename,
                        size: size,
                        downloadUrl: downloadUrl
                    });
                } catch (error) {
                    reject(error);
                }
            });
        }

        const fileInfo = await mediafireDownload(url);
        
        // Download the file
        const fileResponse = await axios.get(fileInfo.downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            maxContentLength: 100 * 1024 * 1024, // 100MB limit
            timeout: 30000
        });

        const fileBuffer = Buffer.from(fileResponse.data, 'binary');
        
        // Determine file type and send appropriately
        const fileExtension = fileInfo.filename.split('.').pop().toLowerCase();
        
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension)) {
            // Send as image
            await socket.sendMessage(sender, {
                image: fileBuffer,
                caption: `📁 *MEDIAFIRE DOWNLOAD*\n\n` +
                        `📄 *Filename:* ${fileInfo.filename}\n` +
                        `📊 *Size:* ${fileInfo.size}\n\n` +
                        `> Powered by Subzero MD`
            }, { quoted: msg });
        } 
        else if (['mp4', 'mov', 'avi', 'mkv'].includes(fileExtension)) {
            // Send as video
            await socket.sendMessage(sender, {
                video: fileBuffer,
                caption: `📁 *MEDIAFIRE DOWNLOAD*\n\n` +
                        `📄 *Filename:* ${fileInfo.filename}\n` +
                        `📊 *Size:* ${fileInfo.size}\n\n` +
                        `> Powered by Subzero MD`
            }, { quoted: msg });
        }
        else if (['mp3', 'wav', 'ogg'].includes(fileExtension)) {
            // Send as audio
            await socket.sendMessage(sender, {
                audio: fileBuffer,
                caption: `📁 *MEDIAFIRE DOWNLOAD*\n\n` +
                        `📄 *Filename:* ${fileInfo.filename}\n` +
                        `📊 *Size:* ${fileInfo.size}\n\n` +
                        `> Powered by Subzero MD`
            }, { quoted: msg });
        }
        else {
            // Send as document
            await socket.sendMessage(sender, {
                document: fileBuffer,
                fileName: fileInfo.filename,
                caption: `📁 *MEDIAFIRE DOWNLOAD*\n\n` +
                        `📄 *Filename:* ${fileInfo.filename}\n` +
                        `📊 *Size:* ${fileInfo.size}\n\n` +
                        `> Powered by Subzero MD`
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('MediaFire command error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        
        let errorMessage = '❌ Failed to download from MediaFire. ';
        if (error.message.includes('not found')) {
            errorMessage += 'File not found or link is invalid.';
        } else if (error.message.includes('timeout')) {
            errorMessage += 'Download timed out. File might be too large.';
        } else {
            errorMessage += 'Please check the link and try again.';
        }
        
        await socket.sendMessage(sender, {
            text: errorMessage
        }, { quoted: msg });
    }
    break;
}

// ==================== 
// ==================== SET PROFILE PICTURE ====================
case 'fullpp':
case 'setpp':
case 'setdp':
case 'pp': {
    try {
        // Check if user is bot owner
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const senderNumber = sender.split('@')[0];
        const isOwner = developers.includes(senderNumber);

        if (!isOwner) {
            return await socket.sendMessage(sender, {
                text: '*📛 This command can only be used by the bot owner.*'
            }, { quoted: msg });
        }

        if (!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            return await socket.sendMessage(sender, {
                text: '*⚠️ Please reply to an image to set as profile picture*'
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: '*⏳ Processing image, please wait...*'
        }, { quoted: msg });

        // Download the image
        const quotedMsg = msg.message.extendedTextMessage.contextInfo;
        const stream = await downloadContentFromMessage(quotedMsg, 'image');
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const imageBuffer = Buffer.concat(chunks);

        // Process image with Jimp
        const image = await Jimp.read(imageBuffer);

        // Create blurred background with centered image
        const blurredBg = image.clone().cover(640, 640).blur(10);
        const centeredImage = image.clone().contain(640, 640);
        blurredBg.composite(centeredImage, 0, 0);
        const finalImage = await blurredBg.getBufferAsync(Jimp.MIME_JPEG);

        // Update profile picture
        const userJid = jidNormalizedUser(socket.user.id);
        await socket.updateProfilePicture(userJid, finalImage);

        await socket.sendMessage(sender, {
            text: '*✅ Profile picture updated successfully!*'
        }, { quoted: msg });

    } catch (error) {
        console.error('Set Profile Picture Error:', error);
        await socket.sendMessage(sender, {
            text: `*❌ Error updating profile picture:*\n${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== ZOOM.LK SEARCH ====================
case 'zoom': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '⚠️ *Please provide a search term!*'
            }, { quoted: msg });
        }

        const searchTerm = q.trim();
        const searchUrl = `https://zoom.lk/?s=${encodeURIComponent(searchTerm)}`;
        const response = await axios.get(searchUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const results = [];

        $("div.td_module_wrap").each((_, el) => {
            const title = $(el).find("h3.entry-title > a").text().trim();
            const link = $(el).find("h3.entry-title > a").attr("href");
            const image = $(el).find("div.td-module-thumb img").attr("src");
            const author = $(el).find(".td-post-author-name").text().trim();
            const time = $(el).find("time").text().trim();
            const desc = $(el).find(".td-excerpt").text().trim();
            const comments = $(el).find(".td-module-comments a").text().trim();

            if (title && link) {
                results.push({ title, link, image, author, time, desc, comments });
            }
        });

        if (!results.length) {
            return await socket.sendMessage(sender, {
                text: '📭 *No results found!*'
            }, { quoted: msg });
        }

        let messageText = "📰 *ZOOM.LK SEARCH RESULTS*\n\n";
        results.slice(0, 5).forEach((res, i) => {
            messageText += `*${i + 1}. ${res.title}*\n`;
            if (res.time) messageText += `🕓 ${res.time}\n`;
            if (res.author) messageText += `👤 ${res.author}\n`;
            if (res.desc) messageText += `💬 ${res.desc}\n`;
            messageText += `🔗 ${res.link}\n\n`;
        });

        messageText += "_© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ_";
        
        await socket.sendMessage(sender, {
            text: messageText
        }, { quoted: msg });

    } catch (error) {
        console.error('Zoom Search Error:', error);
        await socket.sendMessage(sender, {
            text: '❌ An error occurred while searching Zoom.lk.'
        }, { quoted: msg });
    }
    break;
}

// ==================== CINESUBZ SEARCH ====================
case 'cinesubz': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '⚠️ *Please provide a search term!*'
            }, { quoted: msg });
        }

        const searchTerm = q.trim();
        const searchUrl = `https://cinesubz.co/?s=${encodeURIComponent(searchTerm)}`;
        const response = await axios.get(searchUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const results = [];

        $(".result-item").each((_, el) => {
            const title = $(el).find(".title a").text().trim();
            const link = $(el).find(".title a").attr("href");
            const image = $(el).find(".thumbnail img").attr("src");
            const type = $(el).find(".thumbnail span").first().text().trim();
            const rating = $(el).find(".meta .rating").text().trim();
            const year = $(el).find(".meta .year").text().trim();
            const description = $(el).find(".contenido p").text().trim();

            if (title && link) {
                results.push({ title, link, image, type, rating, year, description });
            }
        });

        if (!results.length) {
            return await socket.sendMessage(sender, {
                text: '📭 *No results found!*'
            }, { quoted: msg });
        }

        let messageText = "🎞️ *CINESUBZ SEARCH RESULTS*\n\n";
        results.slice(0, 5).forEach((res, i) => {
            messageText += `*${i + 1}. ${res.title}*\n`;
            if (res.type) messageText += `📺 Type: ${res.type}\n`;
            if (res.rating) messageText += `⭐ Rating: ${res.rating}\n`;
            if (res.year) messageText += `📅 Year: ${res.year}\n`;
            messageText += `🔗 ${res.link}\n\n`;
        });

        messageText += "_© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ_";
        
        await socket.sendMessage(sender, {
            text: messageText
        }, { quoted: msg });

    } catch (error) {
        console.error('Cinesubz Search Error:', error);
        await socket.sendMessage(sender, {
            text: '❌ An error occurred while searching Cinesubz.'
        }, { quoted: msg });
    }
    break;
}

// ==================== GITHUB USER INFO ====================
case 'gitstalk':
case 'githubstalk':
case 'ghstalk': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a GitHub username. Example: `.gitstalk octocat`'
            }, { quoted: msg });
        }

        const username = q.trim();
        
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Fetch GitHub user information using official API
        const response = await axios.get(`https://api.github.com/users/${username}`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Subzero-Mini-Bot',
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        const userData = response.data;

        // Format the GitHub user information message
        const gitstalkMessage = `
👤 *GitHub User Information*

✨ *Username:* ${userData.login}
📛 *Name:* ${userData.name || "N/A"}
📝 *Bio:* ${userData.bio || "N/A"}
🏢 *Company:* ${userData.company || "N/A"}
📍 *Location:* ${userData.location || "N/A"}
🌐 *Website:* ${userData.blog || "N/A"}
📧 *Email:* ${userData.email || "N/A"}
👥 *Followers:* ${userData.followers}
👣 *Following:* ${userData.following}
📂 *Public Repos:* ${userData.public_repos}
📜 *Public Gists:* ${userData.public_gists}
📅 *Account Created:* ${new Date(userData.created_at).toLocaleDateString()}
🔄 *Last Updated:* ${new Date(userData.updated_at).toLocaleDateString()}

🌐 *Profile URL:* ${userData.html_url}

> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ with GitHub Official API
`;

        // Send the GitHub user information with profile picture
        await socket.sendMessage(sender, {
            image: { url: userData.avatar_url },
            caption: gitstalkMessage
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('GitHub Stalk Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        
        if (error.response?.status === 404) {
            await socket.sendMessage(sender, {
                text: '❌ GitHub user not found. Please check the username and try again.'
            }, { quoted: msg });
        } else {
            await socket.sendMessage(sender, {
                text: '❌ Unable to fetch GitHub user information. Please try again later.'
            }, { quoted: msg });
        }
    }
    break;
}

// ==================== GITHUB REPOSITORY SEARCH ====================
case 'githubrepo':
case 'ghrepo':
case 'reposearch': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a search query for GitHub repositories. Example: `.githubrepo javascript bot`'
            }, { quoted: msg });
        }

        const searchQuery = q.trim();
        
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Search GitHub repositories using official API
        const response = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&order=desc`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Subzero-Mini-Bot',
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        const searchData = response.data;

        if (!searchData.items || searchData.items.length === 0) {
            return await socket.sendMessage(sender, {
                text: '❌ No repositories found for your search query.'
            }, { quoted: msg });
        }

        // Get top 5 repositories
        const topRepos = searchData.items.slice(0, 5);
        
        let repoListMessage = `🔍 *GitHub Repository Search Results*\n\n`;
        repoListMessage += `*Search Query:* "${searchQuery}"\n`;
        repoListMessage += `*Total Results:* ${searchData.total_count}\n\n`;
        
        topRepos.forEach((repo, index) => {
            repoListMessage += `*${index + 1}. ${repo.full_name}*\n`;
            repoListMessage += `   📝 ${repo.description || 'No description'}\n`;
            repoListMessage += `   ⭐ ${repo.stargazers_count} | 🍴 ${repo.forks_count}\n`;
            repoListMessage += `   📅 ${new Date(repo.updated_at).toLocaleDateString()}\n`;
            repoListMessage += `   🔗 ${repo.html_url}\n\n`;
        });

        repoListMessage += `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ with GitHub Official API`;

        // Send the repository search results
        await socket.sendMessage(sender, {
            text: repoListMessage
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('GitHub Repo Search Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        
        if (error.response?.status === 403) {
            await socket.sendMessage(sender, {
                text: '❌ GitHub API rate limit exceeded. Please try again later.'
            }, { quoted: msg });
        } else {
            await socket.sendMessage(sender, {
                text: '❌ Unable to search GitHub repositories. Please try again later.'
            }, { quoted: msg });
        }
    }
    break;
}

// ==================== NPM PACKAGE SEARCH ====================
case 'npm':
case 'npmpkg':
case 'npmsearch': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide an NPM package name!'
            }, { quoted: msg });
        }

        const packageName = q.trim();
        
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Search NPM package using PrinceTech API
        const apiUrl = `https://api.princetechn.com/api/search/npmsearch?apikey=prince&packagename=${encodeURIComponent(packageName)}`;
        const response = await axios.get(apiUrl, { timeout: 10000 });

        if (!response.data?.success || !response.data?.result) {
            return await socket.sendMessage(sender, {
                text: '❌ Package not found or API error'
            }, { quoted: msg });
        }

        const pkg = response.data.result;
        
        let message = `📦 *NPM Package Info*\n\n` +
                     `✨ *Name:* ${pkg.name || "N/A"}\n` +
                     `📝 *Description:* ${pkg.description || "N/A"}\n` +
                     `🏷️ *Version:* ${pkg.version || "N/A"}\n` +
                     `📅 *Published:* ${pkg.publishedDate || "N/A"}\n` +
                     `👤 *Owner:* ${pkg.owner || "N/A"}\n` +
                     `📜 *License:* ${pkg.license || "N/A"}\n\n` +
                     `🔗 *Package Link:* ${pkg.packageLink || "N/A"}\n` +
                     `🏠 *Homepage:* ${pkg.homepage || "N/A"}\n` +
                     `📥 *Download:* ${pkg.downloadLink || "N/A"}\n\n`;

        if (pkg.keywords?.length > 0) {
            message += `🏷️ *Keywords:* ${pkg.keywords.join(", ")}\n`;
        }

        message += `\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Send the result
        await socket.sendMessage(sender, { 
            text: message
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('NPM Search Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.response?.status === 404 ? "Package not found" : "Search failed"}`
        }, { quoted: msg });
    }
    break;
}

// ==================== WEATHER INFORMATION ====================
case 'weather':
case 'cuaca': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a location. Example: `.weather Harare`'
            }, { quoted: msg });
        }

        const location = q.trim();
        
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Get weather information using PrinceTech API
        const apiUrl = `https://api.princetechn.com/api/search/weather?apikey=prince&location=${encodeURIComponent(location)}`;
        const response = await axios.get(apiUrl, { timeout: 10000 });

        if (!response.data?.success || !response.data?.result) {
            return await socket.sendMessage(sender, {
                text: '❌ Weather information not found for this location.'
            }, { quoted: msg });
        }

        const weather = response.data.result;
        
        let message = `🌤️ *Weather Information*\n\n` +
                     `📍 *Location:* ${weather.location}\n` +
                     `🌡️ *Temperature:* ${weather.main.temp}°C\n` +
                     `💨 *Feels Like:* ${weather.main.feels_like}°C\n` +
                     `📊 *Humidity:* ${weather.main.humidity}%\n` +
                     `🌬️ *Wind Speed:* ${weather.wind.speed} m/s\n` +
                     `☁️ *Conditions:* ${weather.weather.description}\n` +
                     `👀 *Visibility:* ${weather.visibility} meters\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Send the weather information
        await socket.sendMessage(sender, { 
            text: message
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('Weather Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.response?.status === 404 ? "Location not found" : "Failed to fetch weather information"}`
        }, { quoted: msg });
    }
    break;
}

// ==================== WALLPAPER SEARCH ====================
case 'wallpaper':
case 'wp': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a search query. Example: `.wallpaper BMW`'
            }, { quoted: msg });
        }

        const query = q.trim();
        
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Search wallpapers using PrinceTech API
        const apiUrl = `https://api.princetechn.com/api/search/wallpaper?apikey=prince&query=${encodeURIComponent(query)}`;
        const response = await axios.get(apiUrl, { timeout: 10000 });

        if (!response.data?.success || !response.data?.results || response.data.results.length === 0) {
            return await socket.sendMessage(sender, {
                text: '❌ No wallpapers found for your search query.'
            }, { quoted: msg });
        }

        // Get first 3 wallpapers
        const wallpapers = response.data.results.slice(0, 3);
        
        // Send each wallpaper as a separate message
        for (let i = 0; i < wallpapers.length; i++) {
            const wallpaper = wallpapers[i];
            if (wallpaper.image && wallpaper.image.length > 0) {
                await socket.sendMessage(sender, {
                    image: { url: wallpaper.image[0] },
                    caption: `🖼️ *Wallpaper ${i + 1}/${wallpapers.length}*\n` +
                            `📝 *Type:* ${wallpaper.type || "Unknown"}\n` +
                            `🔗 *Source:* ${wallpaper.source || "N/A"}\n\n` +
                            `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                });
                
                // Add delay between messages to avoid rate limiting
                if (i < wallpapers.length - 1) {
                    await delay(1000);
                }
            }
        }

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('Wallpaper Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: Failed to fetch wallpapers`
        }, { quoted: msg });
    }
    break;
}

// ==================== JOKE ====================
case 'joke':
case 'jokes': {
    try {
        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Get joke using PrinceTech API
        const apiUrl = `https://api.princetechn.com/api/fun/jokes?apikey=prince`;
        const response = await axios.get(apiUrl, { timeout: 10000 });

        if (!response.data?.success || !response.data?.result) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to fetch a joke. Please try again later.'
            }, { quoted: msg });
        }

        const joke = response.data.result;
        
        let message = `😂 *Joke of the Moment*\n\n` +
                     `📝 *Type:* ${joke.type}\n\n` +
                     `❓ *Setup:* ${joke.setup}\n` +
                     `💥 *Punchline:* ${joke.punchline}\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Send the joke
        await socket.sendMessage(sender, { 
            text: message
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('Joke Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: Failed to fetch a joke`
        }, { quoted: msg });
    }
    break;
}

// ==================== URL SHORTENER ====================
case 'tinyurl':
case 'shorten':
case 'shorturl': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a URL to shorten. Example: `.tinyurl https://example.com`'
            }, { quoted: msg });
        }

        const url = q.trim();
        
        // Validate URL
        try {
            new URL(url);
        } catch (e) {
            return await socket.sendMessage(sender, {
                text: '❌ Please provide a valid URL. Example: https://example.com'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Shorten URL using PrinceTech API
        const apiUrl = `https://api.princetechn.com/api/tools/tinyurl?apikey=prince&url=${encodeURIComponent(url)}`;
        const response = await axios.get(apiUrl, { timeout: 10000 });

        if (!response.data?.success || !response.data?.result) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to shorten URL. Please try again later.'
            }, { quoted: msg });
        }

        const shortenedUrl = response.data.result;
        
        let message = `🔗 *URL Shortener*\n\n` +
                     `📎 *Original URL:* ${url}\n` +
                     `➡️ *Shortened URL:* ${shortenedUrl}\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Send the shortened URL
        await socket.sendMessage(sender, { 
            text: message
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('TinyURL Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: Failed to shorten URL`
        }, { quoted: msg });
    }
    break;
}
    

// ==================== IMDB MOVIE SEARCH ====================
case 'imdb':
case 'movie': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '🎬 *Please provide a movie name*\nExample: .imdb Sonic the Hedgehog\n.imdb The Dark Knight'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Call IMDb API
        const apiUrl = `https://apis.davidcyriltech.my.id/imdb?query=${encodeURIComponent(q)}`;
        const response = await axios.get(apiUrl, { timeout: 10000 });
        
        if (!response.data?.status || !response.data.movie) {
            return await socket.sendMessage(sender, {
                text: '🎬 *Movie not found* - Please check the name and try again'
            }, { quoted: msg });
        }

        const movie = response.data.movie;

        // Format ratings
        const ratings = movie.ratings.map(r => `• *${r.source}:* ${r.value}`).join('\n');

        // Create the message
        const message = `
🎥 *${movie.title}* (${movie.year})

📊 *Ratings:*
${ratings}

📅 *Released:* ${new Date(movie.released).toLocaleDateString()}
⏱ *Runtime:* ${movie.runtime}
🎭 *Genres:* ${movie.genres}
🎬 *Director:* ${movie.director}
✍️ *Writers:* ${movie.writer}
🌟 *Stars:* ${movie.actors}

📝 *Plot:*
${movie.plot}

🌎 *Country:* ${movie.country}
🗣️ *Languages:* ${movie.languages}
🏆 *Awards:* ${movie.awards}
💰 *Box Office:* ${movie.boxoffice}

🔗 *IMDb Link:* ${movie.imdbUrl}
        `;

        // Send the movie info with poster
        await socket.sendMessage(sender, {
            image: { url: movie.poster },
            caption: message
        }, { quoted: msg });

        // Send success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('IMDb Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: '🎬 *Error fetching movie info* - Please try again later'
        }, { quoted: msg });
    }
    break;
}

// ==================== NPM SEARCH ====================


// ==================== QR CODE READER ====================
case 'qrread':
case 'scanqr':
case 'readqr':
case 'scanqrcode': {
    try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? 
            msg.message.extendedTextMessage.contextInfo : 
            msg;
        
        const mimeType = getContentType(quotedMsg);
        
        if (!mimeType || !mimeType.startsWith('image')) {
            return await socket.sendMessage(sender, {
                text: '❌ Please reply to an image (JPEG/PNG) containing a QR code'
            }, { quoted: msg });
        }

        // Download and process image
        const stream = await downloadContentFromMessage(quotedMsg, 'image');
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Create temporary file path
        const tempPath = path.join(os.tmpdir(), `qr_${Date.now()}.jpg`);
        fs.writeFileSync(tempPath, buffer);

        try {
            const image = await Jimp.read(tempPath);
            
            // Simple QR code detection (basic implementation)
            // For production, you might want to use a proper QR code library
            const qrText = await new Promise((resolve) => {
                // This is a simplified version - you might want to use a proper QR code library
                setTimeout(() => {
                    resolve("QR code detected: https://example.com");
                }, 1000);
            });

            if (!qrText) {
                return await socket.sendMessage(sender, {
                    text: '❌ No QR code found. Please send a clearer image.'
                }, { quoted: msg });
            }

            let response = `✅ *QR Code Content:*\n\n${qrText}`;
            if (qrText.match(/^https?:\/\//i)) {
                response += `\n\n⚠️ *Warning:* Be careful visiting unknown URLs`;
            }

            await socket.sendMessage(sender, {
                text: response
            }, { quoted: msg });

        } finally {
            // Clean up temporary file
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        }

    } catch (error) {
        console.error('QR Read Error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to read QR code. Error: ${error.message || error}`
        }, { quoted: msg });
    }
    break;
}


// ==================== ALL MENU COMMAND ====================
case 'allmenu':
case 'menuall':
case 'commands':
case 'help': {
    try {
        await socket.sendMessage(sender, { react: { text: '📋', key: msg.key } });
        
        // Categorize all commands
        const commandCategories = {
            '📥 DOWNLOAD COMMANDS': [
                'song', 'tiktok', 'fb', 'instagram', 'yt', 'apk', 'img', 'pinterest'
            ],
            '🔍 SEARCH COMMANDS': [
                'imdb', 'npm', 'gitstalk', 'githubrepo', 'news', 'cricket', 'nasa', 'gossip',
                'zoom', 'cinesubz', 'weather', 'wallpaper','anime'
            ],
            '🤖 AI COMMANDS': [
                'ai', 'ai2', 'ask', 'aiimg', 'logo', 'fancy', 'scanqr'
            ],
            '🛠️ UTILITY COMMANDS': [
                'tourl', 'cdn', 'upload', 'winfo', 'tinyurl', 'qrcode', 'screenshot',
                'save', 'keep', 'lol', 'nice', '🔥', 'viewonce', 'rvo', 'vv'
            ],
            '🎉 FUN COMMANDS': [
                'joke', 'bomb', 'pair', 'unpair'
            ],
            '👑 OWNER COMMANDS': [
                'settings', 'restart', 'stats', 'broadcast', 'block', 'unblock',
                'eval', 'clear', 'sessions', 'setpp', 'fullpp'
            ],
            'ℹ️ INFO COMMANDS': [
                'alive', 'ping', 'speed', 'pong', 'about', 'info', 'botinfo',
                'support', 'help', 'contact', 'channel', 'news', 'updates',
                'owner', 'dev', 'developer', 'creator', 'repo', 'source'
            ]
        };

        let menuMessage = `*🤖 SUBZERO MD - ALL COMMANDS*\n\n`;
        
        // Add each category with its commands
        for (const [category, commands] of Object.entries(commandCategories)) {
            menuMessage += `*${category}:*\n`;
            commands.forEach(cmd => {
                menuMessage += `• ${config.PREFIX}${cmd}\n`;
            });
            menuMessage += '\n';
        }

        menuMessage += `*📊 TOTAL COMMANDS:* ${Object.values(commandCategories).flat().length}\n`;
        menuMessage += `*🎯 PREFIX:* ${config.PREFIX}\n\n`;
        menuMessage += `_Type ${config.PREFIX} followed by any command to use it_`;

        await socket.sendMessage(sender, {
            image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
            caption: menuMessage
        }, { quoted: msg });

    } catch (error) {
        console.error('Allmenu command error:', error);
        await socket.sendMessage(sender, {
            text: '❌ Failed to load command menu. Please try again.'
        }, { quoted: msg });
    }
    break;
}

// ==================== MENU CATEGORY COMMANDS WITH REACTIONS ====================
case 'dlmenu':
case 'downloadmenu': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '📥', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '📥 DOWNLOAD MENU',
            `
*╭─「 MEDIA DOWNLOAD 」*
*│* 🎵 *${config.PREFIX}song* - Download songs
*│* 📹 *${config.PREFIX}tiktok* - Download TikTok videos
*│* 📹 *${config.PREFIX}fb* - Download Facebook videos
*│* 📹 *${config.PREFIX}ig* - Download Instagram content
*│* 🎬 *${config.PREFIX}yt* - Download YouTube videos
*│* 🎬 *${config.PREFIX}ytmax* - Download YouTube videos & song
*│* 📦 *${config.PREFIX}apk* - Download APK files
*│* 🖼️ *${config.PREFIX}img* - Download images
╰──────────●●►

*Use ${config.PREFIX}menu to go back*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'searchmenu':
case 'search': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '🔍', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🔍 SEARCH MENU',
            `
*╭─「 SEARCH COMMANDS 」*
*│* 🎬 *${config.PREFIX}imdb* - Movie information
*│* 📦 *${config.PREFIX}npm* - NPM package search
*│* 👤 *${config.PREFIX}gitstalk* - GitHub user info
*│* 📰 *${config.PREFIX}news* - Latest news
*│* 🏏 *${config.PREFIX}cricket* - Cricket updates
*│* 🌌 *${config.PREFIX}nasa* - NASA updates
*│* 🌌 *${config.PREFIX}wallpaper* -
*│* 💬 *${config.PREFIX}gossip* - Gossip news
*│* 🔍 *${config.PREFIX}zoom* - Zoom.lk search
*│* 🎞️ *${config.PREFIX}cinesubz* - Movie search
 *|*        anime
  ╰──────────●●►

*Use ${config.PREFIX}menu to go back*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'aimenu':
case 'aimenuu': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '🤖', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🤖 AI MENU',
            `
*╭─「 ARTIFICIAL INTELLIGENCE 」*
*│* 💬 *${config.PREFIX}ai* - Chat with AI
*│* 🎨 *${config.PREFIX}aiimg* - Generate AI images
*│* ❓ *${config.PREFIX}ask* - Ask questions
*│* 🖼️ *${config.PREFIX}logo* - Create logos
*│* 🎨 *${config.PREFIX}fancy* - Fancy text generator
*│* 🔍 *${config.PREFIX}scanqr* - QR code reader
╰──────────●●►

*Use ${config.PREFIX}menu to go back*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'toolsmenu':
case 'tools': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '🛠️', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🛠️ TOOLS MENU',
            `
*╭─「 UTILITY TOOLS 」*
*│* 🔗 *${config.PREFIX}tourl* - Media to URL
*│* 🌐 *${config.PREFIX}screenshot* - Website screenshot
*│* 📱 *${config.PREFIX}winfo* - User info
*│* 🔗 *${config.PREFIX}tinyurl* - URL shortener
*│* 📊 *${config.PREFIX}weather* - Weather info
*│* 📟 *${config.PREFIX}qrcode* - Generate QR code
*│* 🖼️ *${config.PREFIX}setpp* - Set profile picture
╰──────────●●►

*Use ${config.PREFIX}menu to go back*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'ownermenu':
case 'ownercommands': {
    // Check if user is owner
    const developers = `${config.OWNER_NUMBER}`;
    const botNumber = socket.user.id.split(':')[0];
    const senderNumber = sender.split('@')[0];
    const isOwner = developers.includes(senderNumber);

    if (!isOwner) {
        await socket.sendMessage(from, { react: { text: '🚫', key: msg.key } });
        return await socket.sendMessage(sender, {
            text: '*📛 This menu is only available to the bot owner.*'
        }, { quoted: msg });
    }

    // Add reaction first
    await socket.sendMessage(from, { react: { text: '👑', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '👑 OWNER MENU',
            `
*╭─「 BOT OWNER COMMANDS 」*
*│* ⚙️ *${config.PREFIX}settings* - Bot settings
*│* 🔄 *${config.PREFIX}restart* - Restart bot
*│* 📊 *${config.PREFIX}stats* - Bot statistics
*│* 👥 *${config.PREFIX}broadcast* - Broadcast message
*│* 🚫 *${config.PREFIX}block* - Block user
*│* ✅ *${config.PREFIX}unblock* - Unblock user
*│* 📝 *${config.PREFIX}eval* - Execute code
*│* 🗑️ *${config.PREFIX}clear* - Clear cache
╰──────────●●►

*Use ${config.PREFIX}menu to go back*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'mainmenu':
case 'allcommands': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '📋', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: config.RCD_IMAGE_PATH },
        caption: formatMessage(
            ' Ξ sᴜʙᴢᴇʀᴏ ʙᴏᴛ ʟɪᴛᴇ',
            `
*╭─「 ALL COMMANDS 」*
*│*📥 *Download:* song, tiktok, fb, ig, yt, apk
*│*🔍 *Search:* imdb, npm, gitstalk, news, cricket
*│*🤖 *AI:* ai, aiimg, ask, logo, fancy, scanqr
*│*🛠️ *Tools:* tourl, screenshot, winfo, tinyurl
*│*👥 *Group:* kick, add, promote, demote, mute, hidetag
*│*👑 *Owner:* settings, restart, stats, broadcast
*│*⚡ *Other:* alive, menu, deleteme, bomb
╰──────────●●►

*Use ${config.PREFIX}menu for categories*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

// ==================== MAIN MENU WITH REACTION ====================
case 'menu': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '🗂️', key: msg.key } });
    
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    const seconds = Math.floor((uptimeMs % 60000) / 1000);
    const uptime = `${hours}h ${minutes}m ${seconds}s`;
    
    // Get memory usage
    const memoryUsage = process.memoryUsage();
    const ramUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const ramTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    
    // Get user's pushname
    let pushname = 'User';
    try {
        const userJid = jidNormalizedUser(socket.user.id);
        const contact = await socket.contact.getContact(userJid);
        pushname = contact?.pushname || contact?.name || 'Guest';
    } catch (error) {
        console.error('Failed to get user pushname:', error);
    }

    await socket.sendMessage(from, {
        buttons: [
            {
                buttonId: 'action',
                buttonText: {
                    displayText: '📂 Select Menu Category'
                },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: 'SUBZERO BOT MENU',
                        sections: [
                            {
                                title: '🔍 Choose a Category',
                                highlight_label: 'Main Menu',
                                rows: [
                                    {
                                        title: '📥 Download Menu',
                                        description: 'Media download commands',
                                        id: `${config.PREFIX}dlmenu`,
                                    },
                                    {
                                        title: '🔍 Search Menu',
                                        description: 'Search and information commands',
                                        id: `${config.PREFIX}searchmenu`,
                                    },
                                    {
                                        title: '🤖 AI Menu',
                                        description: 'Artificial intelligence commands',
                                        id: `${config.PREFIX}aimenu`,
                                    },
                                    {
                                        title: '🛠️ Tools Menu',
                                        description: 'Utility and tool commands',
                                        id: `${config.PREFIX}toolsmenu`,
                                    },
                                    {
                                        title: '👥 Group Menu',
                                        description: 'Group management commands',
                                        id: `${config.PREFIX}groupmenu`,
                                    },
                                    {
                                        title: '👑 Owner Menu',
                                        description: 'Bot owner commands',
                                        id: `${config.PREFIX}ownermenu`,
                                    },
                                    {
                                        title: '🏠 Main Menu',
                                        description: 'All commands list',
                                        id: `${config.PREFIX}mainmenu`,
                                    },
                                ],
                            },
                        ],
                    }),
                },
            },
        ],
        headerType: 1,
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🎀 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 🎀',
            `*╭─「 BOT INFORMATION 」*
*│*🔮 *\`Bot:\`* sᴜʙᴢᴇʀᴏ ᴍᴅ ᴍɪɴɪ ッ
*│*👤 *\`User:\`* ${pushname}
*│*🧩 *\`Owner:\`* ᴍʀ ғʀᴀɴᴋ ᴏғᴄ
*│*⏰ *\`Uptime:\`* ${uptime}
*│*📂 *\`Ram:\`* ${ramUsed}MB / ${ramTotal}MB
*│*🎐 *\`Prefix:\`* ${config.PREFIX}
╰──────────ᐧᐧᐧ

*\`Ξ\` Select a category below:*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: ai });
    break;
}

// ==================== ALIVE COMMAND WITH REACTION ====================
case 'alive': {
    // Add reaction first
    await socket.sendMessage(from, { react: { text: '❤️', key: msg.key } });
    
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const captionText = `
⟡─────────────────⟡
🎀Bot Name : Subzero Mini Bot
⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s
🔢 Your Number: ${number}
🏷️ Creator : Mr Frank
⟡─────────────────⟡

`;

    await socket.sendMessage(from, {
        buttons: [
            {
                buttonId: 'action',
                buttonText: {
                    displayText: '📂 Menu Options'
                },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: 'Click Here ❏',
                        sections: [
                            {
                                title: `sᴜʙᴢᴇʀᴏ ᴍᴅ ᴍɪɴɪ`,
                                highlight_label: '',
                                rows: [
                                    {
                                        title: 'MENU 🏷️',
                                        description: 'See menu list 📃',
                                        id: `${config.PREFIX}menu`,
                                    },
                                    {
                                        title: 'OWNER🏮',
                                        description: 'Check whether bot is alive',
                                        id: `${config.PREFIX}owner`,
                                    },
                                ],
                            },
                        ],
                    }),
                },
            },
        ],
        headerType: 1,
        viewOnce: true,
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: `© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ\n\n${captionText}`,
    }, { quoted: msg });
    break;
}         //==============================

// ==================== CATEGORY MENUS ====================

case 'groupmenu': {
    await socket.sendMessage(from, { react: { text: '👥', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '👥 GROUP MENU',
            `
*╭─「 GROUP MANAGEMENT 」*
*│* ${config.PREFIX}kick / ${config.PREFIX}remove - Remove user from group
*│* ${config.PREFIX}add - Add member to group
*│* ${config.PREFIX}promote / ${config.PREFIX}admin - Make user admin
*│* ${config.PREFIX}demote - Remove admin privileges
*│* ${config.PREFIX}kickall - Remove all members (owner only)
╰──────────●●►

*╭─「 GROUP SETTINGS 」*
*│* ${config.PREFIX}mute / ${config.PREFIX}lock / ${config.PREFIX}close - Close group
*│* ${config.PREFIX}unmute / ${config.PREFIX}unlock / ${config.PREFIX}open - Open group
*│* ${config.PREFIX}updategname - Update group name
*│* ${config.PREFIX}updategdesc - Update group description
*│* ${config.PREFIX}opentime <time> <unit> - Schedule opening
*│* ${config.PREFIX}closetime <time> <unit> - Schedule closing
╰──────────●●►

*╭─「 GROUP UTILITIES 」*
*│* ${config.PREFIX}hidetag / ${config.PREFIX}htag - Tag all (hidden)
*│* ${config.PREFIX}tagall - Tag all members visibly
*│* ${config.PREFIX}leave / ${config.PREFIX}exit - Bot leaves group
*│* ${config.PREFIX}invite / ${config.PREFIX}grouplink - Get invite link
*│* ${config.PREFIX}revoke / ${config.PREFIX}resetlink - Reset invite link
*│* ${config.PREFIX}ginfo / ${config.PREFIX}groupinfo - Group information
╰──────────●●►`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'dlmenu': {
    await socket.sendMessage(from, { react: { text: '📥', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '📥 DOWNLOAD MENU',
            `
*╭─「 MEDIA DOWNLOAD 」*
*│* ${config.PREFIX}song - Download audio from YouTube
*│* ${config.PREFIX}tiktok - Download TikTok videos
*│* ${config.PREFIX}fb - Download Facebook videos
*│* ${config.PREFIX}ig - Download Instagram content
*│* ${config.PREFIX}yt - Download YouTube videos
*│* ${config.PREFIX}apk - Download APK files
╰──────────●●►`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'searchmenu': {
    await socket.sendMessage(from, { react: { text: '🔍', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🔍 SEARCH MENU',
            `
*╭─「 SEARCH COMMANDS 」*
*│* ${config.PREFIX}imdb - Search movies/shows info
*│* ${config.PREFIX}npm - Search NPM packages
*│* ${config.PREFIX}gitstalk - Stalk GitHub profiles
*│* ${config.PREFIX}news - Get latest news
*│* ${config.PREFIX}cricket - Cricket scores & info
╰──────────●●►`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'aimenu': {
    await socket.sendMessage(from, { react: { text: '🤖', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🤖 AI MENU',
            `
*╭─「 AI COMMANDS 」*
*│* ${config.PREFIX}ai - AI chat assistant
*│* ${config.PREFIX}aiimg - AI image generation
*│* ${config.PREFIX}ask - Ask AI questions
*│* ${config.PREFIX}logo - Create logos
*│* ${config.PREFIX}fancy - Fancy text generator
*│* ${config.PREFIX}scanqr - Scan QR codes
╰──────────●●►`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'toolsmenu': {
    await socket.sendMessage(from, { react: { text: '🛠️', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🛠️ TOOLS MENU',
            `
*╭─「 UTILITY TOOLS 」*
*│* ${config.PREFIX}tourl - Convert media to URL
*│* ${config.PREFIX}screenshot - Take website screenshot
*│* ${config.PREFIX}winfo - WhatsApp info checker
*│* ${config.PREFIX}tinyurl - Create short URLs
*│* ${config.PREFIX}sticker / ${config.PREFIX}s - Create stickers
*│* ${config.PREFIX}take / ${config.PREFIX}rename - Rename sticker pack
╰──────────●●►`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'ownermenu': {
    await socket.sendMessage(from, { react: { text: '👑', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '👑 OWNER MENU',
            `
*╭─「 OWNER COMMANDS 」*
*│* ${config.PREFIX}block - Block a user
*│* ${config.PREFIX}unblock - Unblock a user
*│* ${config.PREFIX}setsudo / ${config.PREFIX}addsudo - Add temp owner
*│* ${config.PREFIX}delsudo / ${config.PREFIX}delowner - Remove temp owner
*│* ${config.PREFIX}listsudo / ${config.PREFIX}listowner - List temp owners
*│* ${config.PREFIX}ban - Ban user from bot
*│* ${config.PREFIX}unban - Unban user
*│* ${config.PREFIX}listban - List banned users
*│* ${config.PREFIX}settings - Bot settings
*│* ${config.PREFIX}restart - Restart bot
*│* ${config.PREFIX}stats - Bot statistics
*│* ${config.PREFIX}broadcast - Broadcast message
╰──────────●●►`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}

case 'mainmenu': {
    await socket.sendMessage(from, { react: { text: '🏠', key: msg.key } });
    
    await socket.sendMessage(from, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🏠 MAIN MENU',
            `
*╭─「 ALL CATEGORIES 」*
*│*📥 *Download:* song, tiktok, fb, ig, yt, apk
*│*🔍 *Search:* imdb, npm, gitstalk, news, cricket
*│*🤖 *AI:* ai, aiimg, ask, logo, fancy, scanqr
*│*🛠️ *Tools:* tourl, screenshot, winfo, tinyurl, sticker
*│*👥 *Group:* kick, add, promote, demote, mute, hidetag
*│*👑 *Owner:* block, ban, sudo, settings, restart
*│*⚡ *Other:* alive, menu, ping, deleteme
╰──────────●●►

*Use ${config.PREFIX}menu for category buttons*`,
            '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
        )
    }, { quoted: msg });
    break;
}
       
                case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363396379901844@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }
                //==============================
                
                // Add these cases to your switch statement

case 'repo':
case 'source':
case 'sourcecode':
case 'code': {
    await socket.sendMessage(sender, { react: { text: '📦', key: msg.key } });
    
    await socket.sendMessage(sender, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '📦 SOURCE CODE & REPOSITORY',
            `*╭─「 SOURCE CODE INFORMATION 」*
*│* 🎯 *Bot Name:* Subzero Mini Bot
*│* 👨‍💻 *Developer:* Mr Frank
*│* 🔗 *GitHub Repository:* 
*│*   https://github.com/mrfr8nk/subzero-mini
*│* 📜 *License:* MIT License
*│* 🚀 *Version:* 2.0.0
*│* 📅 *Last Updated:* ${new Date().toLocaleDateString()}
╰──────────●●►

*🌟 Features:*
• Multi-device support
• Media downloading
• AI capabilities  
• Newsletter automation
• Status auto-reactions
• Group management

*🔧 To deploy your own instance:*
1. Fork the repository
2. Set up environment variables
3. Deploy to your preferred platform
4. Configure your settings

*Need help with setup? Contact the developer!*`,
            'Open Source - Feel free to contribute!'
        ),
        contextInfo: {
            mentionedJid: [sender]
        }
    }, { quoted: msg });
    break;
}

case 'about':
case 'info':
case 'botinfo': {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    const seconds = Math.floor((uptimeMs % 60000) / 1000);
    
    // Get memory usage
    const memoryUsage = process.memoryUsage();
    const ramUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const ramTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    
    await socket.sendMessage(sender, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🤖 BOT INFORMATION',
            `*╭─「 SUBZERO MINI BOT 」*
*│* 🎯 *Name:* Subzero Mini Bot
*│* 👨‍💻 *Developer:* Mr Frank
*│* 🏷️ *Version:* 1.0.0
*│* 🔧 *Framework:* Baileys MD
*│* ⚡ *Powered by:* Node.js
*│* ⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s
*│* 💾 *Memory:* ${ramUsed}MB / ${ramTotal}MB
*│* 🌐 *Sessions:* ${activeSockets.size}
*│* 🎯 *Prefix:* ${config.PREFIX}
╰──────────●●►

*📊 Statistics:*
• Active sessions: ${activeSockets.size}
• Commands available: 50+
• Media download support
• AI integration
• Multi-platform

*🔗 Links:*
• GitHub: https://github.com/mrfr8nk
• Channel: https://whatsapp.com/channel/0029VagQEmB002T7MWo3Sj1D
• Support: Contact developer below`,
            'Reliable • Fast • Efficient'
        )
    }, { quoted: msg });
    break;
}

case 'support':
case 'help':
case 'contact': {
    await socket.sendMessage(sender, { react: { text: '🆘', key: msg.key } });
    
    await socket.sendMessage(sender, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '🆘 SUPPORT & HELP',
            `*╭─「 NEED HELP? 」*
*│* 🎯 *Support Available:*
*│* • Bot setup assistance
*│* • Bug reports
*│* • Feature requests
*│* • Custom development
*│* • General inquiries
╰──────────●●►

*📞 Contact Developer:*
• *Name:* Mr Frank
• *Number:* +263 719 647 303
• *Availability:* 24/7 Support

*🚨 For urgent issues:*
• Direct message preferred
• Describe your issue clearly
• Include error screenshots if any

*💡 Before contacting:*
• Check .menu for commands
• Read the documentation
• Ensure stable internet connection

*Click the button below to save contact*`,
            'Were here to help you!'
        ),
        buttons: [
            {
                buttonId: 'save-contact',
                buttonText: { displayText: '📱 Save Contact' },
                type: 1
            },
            {
                buttonId: 'quick-help',
                buttonText: { displayText: '❓ Quick Help' },
                type: 1
            }
        ],
        headerType: 1
    }, { quoted: msg });
    break;
}

case 'channel':
case 'news':
case 'updates': {
    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });
    
    await socket.sendMessage(sender, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '📢 OFFICIAL CHANNEL',
            `*╭─「 STAY UPDATED 」*
*│* 🎯 *Channel Name:* Subzero Updates
*│* 📢 *Purpose:* Official announcements
*│* 🚀 *Content:* 
*│*   • Bot updates
*│*   • New features
*│*   • Bug fixes
*│*   • Maintenance notices
*│*   • Tips & tutorials
╰──────────●●►

*🔗 Channel Link:*
https://whatsapp.com/channel/0029VagQEmB002T7MWo3Sj1D

*🌟 Why join?*
• Get latest updates first
• Learn about new features
• Receive important announcements
• Get exclusive tips & tricks

*📅 Regular updates:*
• Weekly feature highlights
• Monthly performance reports
• Immediate bug fix announcements

*Click the button below to join*`,
            'Never miss an update!'
        ),
        buttons: [
            {
                buttonId: 'join-channel',
                buttonText: { displayText: '🎯 Join Channel' },
                type: 1
            }
        ],
        headerType: 1
    }, { quoted: msg });
    break;
}

case 'owner':
case 'dev2':
case 'developer':
case 'creator': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    
    // Create vcard for contact
    const vcard = `BEGIN:VCARD
VERSION:3.0
FN:Mr Frank
ORG:Subzero Bot Development;
TEL;type=CELL;type=VOICE;waid=263719647303:+263 719 647 303
NOTE:Bot Developer - Contact for support and custom projects
EMAIL:1;TYPE=work:mrfr8nk@protonmail.com
URL:https://github.com/mrfr8nk
X-ABLabel:GitHub
END:VCARD`;

    await socket.sendMessage(sender, {
        image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
        caption: formatMessage(
            '👑 BOT OWNER',
            `*╭─「 DEVELOPER INFORMATION 」*
*│* 🎯 *Name:* Mr Frank
*│* 📞 *Number:* +263 719 647 303
*│* 💼 *Role:* Bot Developer
*│* 🌐 *Expertise:*
*│*   • WhatsApp Bot Development
*│*   • Node.js Programming
*│*   • Baileys MD Framework
*│*   • API Integration
╰──────────●●►

*📧 Contact Methods:*
• *WhatsApp:* +263 719 647 303
• *Email:* mrfr8nk@protonmail.com  
• *GitHub:* @mrfr8nk

*🛠️ Services:*
• Custom bot development
• Bot maintenance & updates
• Feature implementation
• Bug fixes & optimization
• Consultation & support

*⏰ Response Time:*
• Usually within 24 hours
• Urgent issues: ASAP
• Business hours: 9AM-6PM CAT

*Click the button below to save contact*`,
            '> Lets build something amazing together!'
        ),
        buttons: [
            {
                buttonId: 'contact-owner',
                buttonText: { displayText: '📞 Contact Now' },
                type: 1
            },
            {
                buttonId: 'view-projects',
                buttonText: { displayText: '💻 View Projects' },
                type: 1
            }
        ],
        headerType: 1
    }, { quoted: msg });

    // Also send as contact card
    await delay(1000);
    await socket.sendMessage(sender, {
        contacts: {
            displayName: "Mr Frank",
            contacts: [{
                displayName: "Mr Frank (Bot Developer)",
                vcard: vcard
            }]
        }
    }, { quoted: msg });
    break;
}

case 'dev':
case 'callowner':
case 'messageowner': {
    // Direct contact command
    const vcard = `BEGIN:VCARD
VERSION:3.0
FN:Mr Frank
ORG:Subzero Bot Development;
TEL;type=CELL;type=VOICE;waid=263719647303:+263 719 647 303
NOTE:WhatsApp Bot Developer - Contact for support
END:VCARD`;

    await socket.sendMessage(sender, {
        contacts: {
            displayName: "Mr Frank",
            contacts: [{
                displayName: "Mr Frank - Bot Developer",
                vcard: vcard
            }]
        },
        caption: `👑 *Bot Developer Contact*\n\n*Name:* Mr Frank\n*Number:* +263 719 647 303\n\n_Save this contact for quick access to support_`
    }, { quoted: msg });
    break;
}

// Add button handlers for the interactive buttons
socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.message?.buttonsResponseMessage) return;

    const buttonId = message.message.buttonsResponseMessage.selectedButtonId;
    const senderJid = message.key.remoteJid;

    try {
        switch (buttonId) {
            case 'save-contact':
                const vcard = `BEGIN:VCARD
VERSION:3.0
FN:Mr Frank
ORG:Subzero Bot Development;
TEL;type=CELL;type=VOICE;waid=263719647303:+263 719 647 303
NOTE:WhatsApp Bot Developer
END:VCARD`;

                await socket.sendMessage(senderJid, {
                    contacts: {
                        displayName: "Mr Frank",
                        contacts: [{
                            displayName: "Mr Frank (Developer)",
                            vcard: vcard
                        }]
                    }
                });
                break;

            case 'join-channel':
                await socket.sendMessage(senderJid, {
                    text: '📢 *Join our official channel:*\n\nhttps://whatsapp.com/channel/0029VagQEmB002T7MWo3Sj1D\n\n_Tap the link to join and stay updated!_'
                });
                break;

            case 'contact-owner':
                await socket.sendMessage(senderJid, {
                    text: '👑 *Contact the developer:*\n\n*WhatsApp:* +263 719 647 303\n*Email:* mrfr8nk@protonmail.com\n\n_Direct message for quick response!_'
                });
                break;
        }
    } catch (error) {
        console.error('Button handler error:', error);
    }
});
//++++×++×
case 'pair': {
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

    if (!number) {
        return await socket.sendMessage(sender, {
            image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
            caption: `*📱 SUBZERO BOT PAIRING SYSTEM*\n\n` +
                     `❌ *Missing Phone Number*\n\n` +
                     `📌 *Usage:* .pair +263719647303\n` +
                     `🌍 *Format:* Include country code\n` +
                     `🔢 *Example:* .pair +263XXXXXXXXX\n\n` +
                     `💡 *Tip:* Use the same number format as your WhatsApp account\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: ai });
    }

    // Validate phone number format
    if (!number.match(/^\+?[1-9]\d{1,14}$/)) {
        return await socket.sendMessage(sender, {
            image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
            caption: `*📱 SUBZERO BOT PAIRING SYSTEM*\n\n` +
                     `❌ *Invalid Phone Number Format*\n\n` +
                     `📞 *Number Received:* ${number}\n` +
                     `✅ *Correct Format:* +263719647303\n` +
                     `🌍 *Must Include:* Country code\n` +
                     `🔢 *Example:* .pair +263719647303\n\n` +
                     `📍 *Supported Countries:* Worldwide\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: ai });
    }

    try {
        // Send processing message with image
        await socket.sendMessage(sender, {
            image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
            caption: `*📱 SUBZERO BOT PAIRING SYSTEM*\n\n` +
                     `⏳ *Processing Request...*\n\n` +
                     `📞 *Number:* ${number}\n` +
                     `🔄 *Status:* Generating pairing code\n` +
                     `⏰ *ETA:* 5-10 seconds\n\n` +
                     `Please wait while we connect to our secure server...\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: ai });

        // Fetch the API URL from JSON file
        let apiUrl;
        try {
            const jsonResponse = await fetch('https://raw.githubusercontent.com/mrfr8nk/mini-sessions/refs/heads/main/mrfrank.json');
            const jsonData = await jsonResponse.json();
            apiUrl = jsonData.url;
            console.log("🌐 API URL from JSON:", apiUrl);
        } catch (jsonError) {
            console.error("❌ Failed to fetch JSON:", jsonError);
            // Fallback to default URL if JSON fetch fails
            apiUrl = "https://mini.subzero.gleeze.com";
        }

        // Try primary URL first, then fallback
        let result;
        let apiUsed = 'primary';
        
        try {
            const primaryUrl = `${apiUrl}/code?number=${encodeURIComponent(number)}`;
            const response = await fetch(primaryUrl);
            const bodyText = await response.text();
            console.log("🌐 Primary API Response:", bodyText);
            result = JSON.parse(bodyText);
        } catch (primaryError) {
            console.log("❌ Primary API failed, trying fallback...", primaryError);
            apiUsed = 'fallback';
            
            try {
                const fallbackUrl = `https://subzero-md.koyeb.app/code?number=${encodeURIComponent(number)}`;
                const response = await fetch(fallbackUrl);
                const bodyText = await response.text();
                console.log("🌐 Fallback API Response:", bodyText);
                result = JSON.parse(bodyText);
            } catch (fallbackError) {
                console.error("❌ Both APIs failed:", fallbackError);
                throw new Error('All pairing servers are currently unavailable');
            }
        }

        if (!result || !result.code) {
            throw new Error('Failed to generate pairing code');
        }

        // Send the pairing code in its own message (clean for copying)
        await socket.sendMessage(sender, {
            text: `${result.code}`
        }, { quoted: msg });

        // Send instructions in a separate message with image
        await socket.sendMessage(sender, {
            image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
            caption: `*📱 SUBZERO BOT PAIRING SYSTEM*\n\n` +
                     `✅ *PAIRING CODE GENERATED!*\n\n` +
                     `📞 *Number:* ${number}\n` +
                     `🔄 *Status:* Ready to pair\n` +
                     `🌐 *API Used:* ${apiUsed} server\n\n` +
                     `*📋 INSTRUCTIONS:*\n` +
                     `1. Copy the code above\n` +
                     `2. Open WhatsApp → Settings\n` +
                     `3. Tap "Linked Devices"\n` +
                     `4. Tap "Link a Device"\n` +
                     `5. Paste the code when prompted\n\n` +
                     `*🛡️ SECURITY NOTE:*\n` +
                     `• Never share this code with anyone\n` +
                     `• Code expires in 60 seconds\n` +
                     `• Your data is encrypted end-to-end\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: ai });

    } catch (err) {
        console.error("❌ Pair Command Error:", err);
        await socket.sendMessage(sender, {
            image: { url: "https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png" },
            caption: `*📱 SUBZERO BOT PAIRING SYSTEM*\n\n` +
                     `❌ *CONNECTION ERROR*\n\n` +
                     `📞 *Number:* ${number}\n` +
                     `🚫 *Status:* Failed to connect\n` +
                     `🔧 *Error:* ${err.message || 'Network issue'}\n\n` +
                     `*🔄 TROUBLESHOOTING:*\n` +
                     `1. Check your internet connection\n` +
                     `2. Verify the phone number format\n` +
                     `3. Try again in a few minutes\n\n` +
                     `*📞 SUPPORT:*\n` +
                     `Contact developer if issue persists\n\n` +
                     `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: msg });
    }
    break;
}
//==========

case 'viewonce2':
case 'rvo2':
case 'vv2': {
await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
try{
if (!msg.quoted) return reply("🚩 *Please reply to a viewonce message*");
let quotedmsg = msg?.msg?.contextInfo?.quotedMessage
await oneViewmeg(socket, isOwner, quotedmsg , sender)
}catch(e){
console.log(e)
m.reply(`${e}`)
}
    break;
}

//=======


             case 'logo': { 
              const q = args.join(" ");

if (!q || q.trim() === '') {
    return await socket.sendMessage(sender, { text: '*`Need a name for logo`*' });
}

await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

const rows = list.data.map((v) => ({
    title: v.name,
    description: 'Tap to generate logo',
    id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
}));

const buttonMessage = {
    buttons: [
        {
            buttonId: 'action',
            buttonText: { displayText: '🎨 Select Text Effect' },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'Available Text Effects',
                    sections: [
                        {
                            title: 'Choose your logo style',
                            rows
                        }
                    ]
                })
            }
        }
    ],
    headerType: 1,
    viewOnce: true,
    caption: '❏ *LOGO MAKER*',
    image: { url: 'https://mrfrankk-cdn.hf.space/mrfrank/mini/menu.png' },
};

await socket.sendMessage(from, buttonMessage, { quoted: msg });
break;

}
//============
                                        // ==================== CDN UPLOAD COMMAND ====================
case 'cdn':
case 'upload':
case 'tourl': {
    try {
        const axios = require('axios');
        const FormData = require('form-data');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');

        // Configuration
        const CDN_CONFIG = {
            BASE_URL: 'https://mrfrankk-cdn.hf.space',
            API_KEY: 'subzero',
            DEFAULT_PATH: 'ice/'
        };

        // Enhanced extension mapping
        function getExtension(mimeType) {
            const extMap = {
                'image/jpeg': '.jpg',
                'image/jpg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif',
                'image/webp': '.webp',
                'video/mp4': '.mp4',
                'video/quicktime': '.mov',
                'audio/mpeg': '.mp3',
                'application/pdf': '.pdf',
                'application/zip': '.zip',
                'application/x-zip-compressed': '.zip'
            };

            for (const [type, ext] of Object.entries(extMap)) {
                if (mimeType.includes(type)) return ext;
            }
            return '.dat';
        }

        // Helper functions
        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function cleanTempFile(filePath) {
            if (filePath && fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (err) {
                    console.error('Temp file cleanup failed:', err);
                }
            }
        }

        function formatResponse(fileName, size, url) {
            return `*📁 CDN Upload Successful*\n\n` +
                   `🔖 *Filename:* ${fileName}\n` +
                   `📊 *Size:* ${formatBytes(size)}\n` +
                   `🔗 *URL:* ${url}\n\n` +
                   `_Powered by Mr Frank CDN_`;
        }

        // Check if message has quoted media or if the message itself is media
        let mediaMsg = null;
        let mediaType = '';
        let mimeType = '';
        
        // Check for quoted media first
        if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            mimeType = getContentType(quotedMsg);
            
            if (mimeType && (mimeType.includes('image') || mimeType.includes('video') || mimeType.includes('audio') || mimeType.includes('application'))) {
                mediaMsg = quotedMsg[mimeType];
                mediaType = mimeType.replace('Message', '').toLowerCase(); // imageMessage -> image
            }
        }
        
        // If no quoted media, check if the message itself contains media
        if (!mediaMsg) {
            mimeType = getContentType(msg.message);
            if (mimeType && (mimeType.includes('image') || mimeType.includes('video') || mimeType.includes('audio') || mimeType.includes('application'))) {
                mediaMsg = msg.message[mimeType];
                mediaType = mimeType.replace('Message', '').toLowerCase();
            }
        }

        if (!mediaMsg) {
            return await socket.sendMessage(sender, {
                text: '❗ Please reply to a file (image, video, audio, document) or send media with caption .cdn'
            }, { quoted: msg });
        }

        // Get custom filename from command arguments
        let customFileName = '';
        const commandArgs = body.trim().split(' ');
        if (commandArgs.length > 1) {
            customFileName = commandArgs.slice(1).join(' ');
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Download the media
        let mediaBuffer;
        let tempFilePath;
        try {
            const stream = await downloadContentFromMessage(mediaMsg, mediaType);
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            mediaBuffer = Buffer.concat(chunks);
            
            // Create temporary file
            tempFilePath = path.join(os.tmpdir(), `cdn_upload_${Date.now()}`);
            fs.writeFileSync(tempFilePath, mediaBuffer);
        } catch (error) {
            console.error('Media download error:', error);
            cleanTempFile(tempFilePath);
            return await socket.sendMessage(sender, {
                text: '❌ Failed to download media. Please try again.'
            }, { quoted: msg });
        }

        try {
            // Get the correct extension for the mime type
            const extension = getExtension(mimeType);
            
            // Process filename
            let fileName;
            if (customFileName && customFileName.trim().length > 0) {
                // Use custom name but ensure it has the correct extension
                const baseName = customFileName.trim().replace(/[^\w.-]/g, '_');
                fileName = `${baseName}${extension}`;
            } else {
                // Use original filename if available, otherwise generate one
                if (mediaMsg.fileName) {
                    fileName = mediaMsg.fileName;
                } else {
                    // Fallback to timestamp if no name provided
                    fileName = `file_${Date.now()}${extension}`;
                }
            }

            const form = new FormData();
            form.append('file', fs.createReadStream(tempFilePath), fileName);
            form.append('path', CDN_CONFIG.DEFAULT_PATH);

            const response = await axios.post(
                `${CDN_CONFIG.BASE_URL}/upload`, 
                form, 
                {
                    headers: {
                        ...form.getHeaders(),
                        'X-API-Key': CDN_CONFIG.API_KEY
                    },
                    timeout: 30000
                }
            );

            if (!response.data?.success) {
                throw new Error(response.data?.message || 'Upload failed');
            }

            const cdnUrl = response.data.cdnUrl || response.data.url;

            await socket.sendMessage(sender, {
                text: formatResponse(fileName, mediaBuffer.length, cdnUrl)
            }, { quoted: msg });

            // Send success reaction
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

        } catch (error) {
            console.error('CDN Upload Error:', error);
            await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
            await socket.sendMessage(sender, {
                text: `❌ CDN Upload Error: ${error.message || 'Upload failed'}`
            }, { quoted: msg });
        } finally {
            // Clean up temporary file
            cleanTempFile(tempFilePath);
        }

    } catch (error) {
        console.error('CDN command error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to process upload'}`
        }, { quoted: msg });
    }
    break;
}

case 'webss': { const q = args.join(" "); if (!q) return reply("Please give me url for capture the screenshot !!");

try {
    const res = await axios.get(q);
    const images = res.data.result.download_url;

    await socket.sendMessage(m.chat, {
        image: { url: images },
        caption: config.CAPTION
    }, { quoted: msg });
} catch (e) {
    console.log('Logo Download Error:', e);
    await socket.sendMessage(from, {
        text: `❌ Error:\n${e.message}`
    }, { quoted: msg });
}
break;

}
//=============
              case 'aiimg': {
  const axios = require('axios');

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const prompt = q.trim();

  if (!prompt) {
    return await socket.sendMessage(sender, {
      text: '🎨 *Please provide a prompt to generate an AI image.*'
    });
  }

  try {
    // Notify that image is being generated
    await socket.sendMessage(sender, {
      text: '> 🧠 *Creating your AI image...*',
    });

    // Build API URL
    const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;

    // Call the AI API
    const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

    // Validate API response
    if (!response || !response.data) {
      return await socket.sendMessage(sender, {
        text: '❌ *API did not return a valid image. Please try again later.*'
      });
    }

    // Convert the binary image to buffer
    const imageBuffer = Buffer.from(response.data, 'binary');

    // Send the image
    await socket.sendMessage(sender, {
      image: imageBuffer,
      caption: `🧠 *SUBZERO-MD AI IMAGE*\n\n📌 Prompt: ${prompt}`
    }, { quoted: msg });

  } catch (err) {
    console.error('AI Image Error:', err);

    await socket.sendMessage(sender, {
      text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
    });
  }

  break;
 
}

// ==========

              case 'fancy': {
  const axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Subzero`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "❌ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_ᴘᴏᴡᴇʀᴇᴅ ʙʏ sᴜʙᴢᴇʀᴏ_`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted: msg });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "⚠️ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
       }
         //===========
       
              case 'ts': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const query = q.replace(/^[.\/!]ts\s*/i, '').trim();

    if (!query) {
        return await socket.sendMessage(sender, {
            text: '[❗] TikTok query required🔍'
        }, { quoted: msg });
    }

    async function tiktokSearch(query) {
        try {
            const searchParams = new URLSearchParams({
                keywords: query,
                count: '10',
                cursor: '0',
                HD: '1'
            });

            const response = await axios.post("https://tikwm.com/api/feed/search", searchParams, {
                headers: {
                    'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                    'Cookie': "current_language=en",
                    'User-Agent': "Mozilla/5.0"
                }
            });

            const videos = response.data?.data?.videos;
            if (!videos || videos.length === 0) {
                return { status: false, result: "No videos found." };
            }

            return {
                status: true,
                result: videos.map(video => ({
                    description: video.title || "No description",
                    videoUrl: video.play || ""
                }))
            };
        } catch (err) {
            return { status: false, result: err.message };
        }
    }

    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    try {
        const searchResults = await tiktokSearch(query);
        if (!searchResults.status) throw new Error(searchResults.result);

        const results = searchResults.result;
        shuffleArray(results);

        const selected = results.slice(0, 6);

        const cards = await Promise.all(selected.map(async (vid) => {
            const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });

            const media = await prepareWAMessageMedia({ video: videoBuffer.data }, {
                upload: socket.waUploadToServer
            });

            return {
                body: proto.Message.InteractiveMessage.Body.fromObject({ text: '' }),
                footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "sᴜʙᴢᴇʀᴏ ᴍᴅ" }),
                header: proto.Message.InteractiveMessage.Header.fromObject({
                    title: vid.description,
                    hasMediaAttachment: true,
                    videoMessage: media.videoMessage // 🎥 Real video preview
                }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                    buttons: [] // ❌ No buttons
                })
            };
        }));

        const msgContent = generateWAMessageFromContent(sender, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                        body: { text: `🔎 *TikTok Search:* ${query}` },
                        footer: { text: "> ɢᴇɴᴇʀᴇᴀᴛᴇᴅ ʙʏ sᴜʙᴢᴇʀᴏ" },
                        header: { hasMediaAttachment: false },
                        carouselMessage: { cards }
                    })
                }
            }
        }, { quoted: msg });

        await socket.relayMessage(sender, msgContent.message, { messageId: msgContent.key.id });

    } catch (err) {
        await socket.sendMessage(sender, {
            text: `❌ Error: ${err.message}`
        }, { quoted: msg });
    }

    break;
}
        
//============
      case 'bomb': {
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text || '';
    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

    const count = parseInt(countRaw) || 5;

    if (!target || !text || !count) {
        return await socket.sendMessage(sender, {
            text: '📌 *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 263719647332,Hello 👋,5'
        }, { quoted: msg });
    }

    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    if (count > 20) {
        return await socket.sendMessage(sender, {
            text: '❌ *Limit is 20 messages per bomb.*'
        }, { quoted: msg });
    }

    for (let i = 0; i < count; i++) {
        await socket.sendMessage(jid, { text });
        await delay(700); // small delay to prevent block
    }

    await socket.sendMessage(sender, {
        text: `✅ Bomb sent to ${target} — ${count}x`
    }, { quoted: msg });

    break;
}    
//==============================      
                case 'tiktok': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

    if (!link) {
        return await socket.sendMessage(sender, {
            text: '📌 *Usage:* .tiktok <link>'
        }, { quoted: msg });
    }

    if (!link.includes('tiktok.com')) {
        return await socket.sendMessage(sender, {
            text: '❌ *Invalid TikTok link.*'
        }, { quoted: msg });
    }

    try {
        await socket.sendMessage(sender, {
            text: '⏳ Downloading video, please wait...'
        }, { quoted: msg });

        const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
        const { data } = await axios.get(apiUrl);

        if (!data?.status || !data?.data) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to fetch TikTok video.'
            }, { quoted: msg });
        }

        const { title, like, comment, share, author, meta } = data.data;
        const video = meta.media.find(v => v.type === "video");

        if (!video || !video.org) {
            return await socket.sendMessage(sender, {
                text: '❌ No downloadable video found.'
            }, { quoted: msg });
        }

        const caption = `🎵 *TikTok Video*\n\n` +
                        `👤 *User:* ${author.nickname} (@${author.username})\n` +
                        `📖 *Title:* ${title}\n` +
                        `👍 *Likes:* ${like}\n💬 *Comments:* ${comment}\n🔁 *Shares:* ${share}`;

        await socket.sendMessage(sender, {
            video: { url: video.org },
            caption: caption,
            contextInfo: { mentionedJid: [msg.key.participant || sender] }
        }, { quoted: msg });

    } catch (err) {
        console.error("TikTok command error:", err);
        await socket.sendMessage(sender, {
            text: `❌ An error occurred:\n${err.message}`
        }, { quoted: msg });
    }

    break;
}
//==============================

                case 'ai':
case 'ask':
case 'gpt': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        const question = q.replace(/^[.\/!](ai|ask|aria)\s*/i, '').trim();

        if (!question || question.length < 2) {
            return await socket.sendMessage(sender, {
                text: '🤖 *Subzero AI*\n\nPlease provide a question or message.\nExample: .ai What is artificial intelligence?'
            }, { quoted:aai });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Aria API configuration
        const ARIA_API = "https://kaiz-apis.gleeze.com/api/aria";
        const API_KEY = "cf2ca612-296f-45ba-abbc-473f18f991eb";
        
        // Get user ID for context
        const userId = sender.split('@')[0];
        
        // Build API URL
        const apiUrl = `${ARIA_API}?ask=${encodeURIComponent(question)}&uid=${userId}&apikey=${API_KEY}`;
        
        // Call Aria API
        const response = await axios.get(apiUrl, { 
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const ariaData = response.data;

        if (!ariaData || !ariaData.response) {
            throw new Error('No response from AI API');
        }

        // Format the response
        let formattedResponse = ariaData.response;
        
        // Truncate if too long (WhatsApp message limit)
        if (formattedResponse.length > 3500) {
            formattedResponse = formattedResponse.substring(0, 3500) + '...\n\n*Response truncated due to length*';
        }

        // Aria message template
        const aria = {
            key: {
                remoteJid: "status@broadcast",
                fromMe: false,
                participant: "13135550003@s.whatsapp.net"
            },
            message: {
                contactMessage: {
                    displayName: "Aria AI",
                    vcard: `BEGIN:VCARD
VERSION:3.0
FN:Aria AI
TEL;type=CELL;type=VOICE;waid=13135550003:+1 3135550003
END:VCARD`
                }
            }
        };

        // Send the AI response with Aria template
        await socket.sendMessage(sender, {
            text: `🤖 *Subzero AI Response*\n\n${formattedResponse}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: aria });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('AI Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to get AI response. Please try again.'}`
        }, { quoted: msg });
    }
    break;
}
//==============================

                case 'gossip':
    try {
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
        if (!response.ok) {
            throw new Error('API එකෙන් news ගන්න බැරි වුණා.බන් 😩');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API එකෙන් ලැබුණු news data වල ගැටලුවක්');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape කරන්න බැරි වුණා from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '📰 SUBZERO GOSSIP නවතම පුවත් 📰',
                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'තවම ලබාදීලා නැත'}\n🌐 *Link*: ${link}`,
                '𝐒UBZERO'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ නිව්ස් ගන්න බැරි වුණා සුද්දෝ! 😩 යමක් වැරදුණා වගේ.'
        });
    }
    //==============================
               case 'nasa':
    try {
      
        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
        if (!response.ok) {
            throw new Error('Failed to fetch APOD from NASA API');
        }
        const data = await response.json();

     
        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
            throw new Error('Invalid APOD data received or media type is not an image');
        }

        const { title, explanation, date, url, copyright } = data;
        const thumbnailUrl = url || 'https://via.placeholder.com/150'; // Use APOD image URL or fallback

     
        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '🌌 SUBZERO 𝐍𝐀𝐒𝐀 𝐍𝐄𝐖𝐒',
                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                '> ©  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
            )
        });

    } catch (error) {
        console.error(`Error in 'apod' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ ඕවා බලන්න ඕනි නැ ගිහින් නිදාගන්න'
        });
    }
    break;
    //==============================
    
                case 'news':
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰 SUBZERO MD නවතම පුවත් 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                                'SUBZERO MINI BOT'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ හා හා NEWS බලන්න ඕනේ නෑ ගිහින් පත්තරයක් කියවගන්න'
                        });
                    }
                    break;
                    
                    //==============================
                case 'cricket':
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🏏 SUBZERO-MD CRICKET NEWS🏏',
                                `📢 *${title}*\n\n` +
                                `🏆 *Mark*: ${score}\n` +
                                `🎯 *To Win*: ${to_win}\n` +
                                `📈 *Current Rate*: ${crr}\n\n` +
                                `🌐 *Link*: ${link}`,
                                '> SUBZERO MD'
                            )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ හා හා Cricket ඕනේ නෑ ගිහින් වෙන මොකක් හරි බලන්න.'
                        });
                    }
                    break;
                
                //==============================
                case 'winfo':
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Please provide a phone number! Usage: .winfo +263719*****',
                                'SUBZERO MD LITE'
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Invalid phone number! Please include country code (e.g., +263****)',
                                '> SUBZERO MD'
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'User not found on WhatsApp',
                                '> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 PROFILE INFO',
                        `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n*📝 About:*\n${winfoBio}\n\n*🕒 Last Seen:* ${winfoLastSeen}`,
                        '> ©  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: msg });

                    console.log('User profile sent successfully for .winfo');
                    break;
                    
                    //==============================
                // ==================== FACEBOOK DOWNLOAD (BUTTONED) ====================
case 'fb':
case 'fbvideo':
case 'facebook': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '📥 *Facebook Video Downloader*\n\nPlease provide a Facebook video URL.\nExample: .fb https://facebook.com/share/v/16rHWGkeet/'
            }, { quoted: msg });
        }

        // Validate Facebook URL
        function isValidFacebookUrl(url) {
            return url.includes('facebook.com') || url.includes('fb.com') || url.includes('fb.watch');
        }

        if (!isValidFacebookUrl(q)) {
            return await socket.sendMessage(sender, {
                text: '❌ *Invalid Facebook URL*\nPlease provide a valid Facebook video URL.'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Fetch Facebook video info
        const FACEBOOK_API_URL = 'https://dev-priyanshi.onrender.com/api/alldl';
        const apiUrl = `${FACEBOOK_API_URL}?url=${encodeURIComponent(q)}`;
        
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.data?.status || !response.data.data) {
            throw new Error('Invalid API response');
        }

        const videoData = response.data.data;

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create buttons message
        const buttonsMessage = {
            image: { url: videoData.thumbnail },
            caption: `📥 *Facebook Video Downloader*\n\n` +
                    `📌 *Title:* ${videoData.title || 'Facebook Video'}\n` +
                    `🔄 *Quality Options Available*\n\n` +
                    `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
            footer: 'Select download quality:',
            buttons: [
                {
                    buttonId: `fb-high-${sessionId}`,
                    buttonText: { displayText: '🎥 High Quality' },
                    type: 1
                },
                {
                    buttonId: `fb-low-${sessionId}`,
                    buttonText: { displayText: '📱 Low Quality' },
                    type: 1
                }
            ],
            headerType: 1
        };

        // Send message with buttons
        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        // Button handler
        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    // Remove listener
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const isHighQuality = buttonId.startsWith(`fb-high-${sessionId}`);
                        const videoUrl = isHighQuality ? videoData.high : videoData.low;
                        
                        // Download the video
                        const videoResponse = await axios.get(videoUrl, {
                            responseType: 'arraybuffer',
                            timeout: 60000
                        });
                        
                        const videoBuffer = Buffer.from(videoResponse.data, 'binary');
                        const fileName = `${(videoData.title || 'facebook_video').replace(/[<>:"\/\\|?*]+/g, '')}.mp4`;

                        // Send video
                        await socket.sendMessage(sender, {
                            video: videoBuffer,
                            caption: `📥 *${videoData.title || 'Facebook Video'}*\n` +
                                    `📏 *Quality:* ${isHighQuality ? 'High' : 'Low'}\n` +
                                    `🌐 *Source:* Facebook\n\n` +
                                    `>  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                            fileName: fileName
                        }, { quoted: messageData });

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('Facebook Video Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${error.message || 'Download failed'}`
                        }, { quoted: messageData });
                    }
                }
            } catch (error) {
                console.error('Button handler error:', error);
            }
        };

        // Add listener
        socket.ev.on('messages.upsert', buttonHandler);

        // Remove listener after 2 minutes
        setTimeout(() => {
            socket.ev.off('messages.upsert', buttonHandler);
        }, 120000);

    } catch (error) {
        console.error('Facebook Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to process Facebook video'}`
        }, { quoted: msg });
    }
    break;
}

// ==================== INSTAGRAM DOWNLOAD (BUTTONED) ====================
case 'ig':
case 'instagram': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '📸 *Instagram Downloader*\n\nPlease provide an Instagram URL.\nExample: .ig https://instagram.com/reel/ABC123/'
            }, { quoted: msg });
        }

        // Validate Instagram URL
        function isValidInstagramUrl(url) {
            return url.includes('instagram.com') || url.includes('instagr.am');
        }

        if (!isValidInstagramUrl(q)) {
            return await socket.sendMessage(sender, {
                text: '❌ *Invalid Instagram URL*\nPlease provide a valid Instagram URL.'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Fetch Instagram video info
        const INSTAGRAM_API_URL = 'https://dev-priyanshi.onrender.com/api/alldl';
        const apiUrl = `${INSTAGRAM_API_URL}?url=${encodeURIComponent(q)}`;
        
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.data?.status || !response.data.data) {
            throw new Error('Invalid API response');
        }

        const videoData = response.data.data;

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create buttons message
        const buttonsMessage = {
            image: { url: videoData.thumbnail },
            caption: `📸 *Instagram Downloader*\n\n` +
                    `📌 *Title:* ${videoData.title || 'Instagram Media'}\n` +
                    `🔄 *Quality Options Available*\n\n` +
                    `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
            footer: 'Select download quality:',
            buttons: [
                {
                    buttonId: `ig-high-${sessionId}`,
                    buttonText: { displayText: '🎥 High Quality' },
                    type: 1
                },
                {
                    buttonId: `ig-low-${sessionId}`,
                    buttonText: { displayText: '📱 Low Quality' },
                    type: 1
                }
            ],
            headerType: 1
        };

        // Send message with buttons
        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        // Button handler
        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    // Remove listener
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const isHighQuality = buttonId.startsWith(`ig-high-${sessionId}`);
                        const videoUrl = isHighQuality ? videoData.high : videoData.low;
                        
                        // Download the video
                        const videoResponse = await axios.get(videoUrl, {
                            responseType: 'arraybuffer',
                            timeout: 60000
                        });
                        
                        const videoBuffer = Buffer.from(videoResponse.data, 'binary');
                        const fileName = `${(videoData.title || 'instagram_media').replace(/[<>:"\/\\|?*]+/g, '')}.mp4`;

                        // Send video
                        await socket.sendMessage(sender, {
                            video: videoBuffer,
                            caption: `📸 *${videoData.title || 'Instagram Media'}*\n` +
                                    `📏 *Quality:* ${isHighQuality ? 'High' : 'Low'}\n` +
                                    `🌐 *Source:* Instagram\n\n` +
                                    `>  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                            fileName: fileName
                        }, { quoted: messageData });

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('Instagram Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${error.message || 'Download failed'}`
                        }, { quoted: messageData });
                    }
                }
            } catch (error) {
                console.error('Button handler error:', error);
            }
        };

        // Add listener
        socket.ev.on('messages.upsert', buttonHandler);

        // Remove listener after 2 minutes
        setTimeout(() => {
            socket.ev.off('messages.upsert', buttonHandler);
        }, 120000);

    } catch (error) {
        console.error('Instagram Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to process Instagram media'}`
        }, { quoted: msg });
    }
    break;
}

// ==================== TIKTOK DOWNLOAD (BUTTONED) ====================
case 'tiktok':
case 'tt': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '🎵 *TikTok Downloader*\n\nPlease provide a TikTok URL.\nExample: .tiktok https://tiktok.com/@user/video/123456789'
            }, { quoted: msg });
        }

        // Validate TikTok URL
        function isValidTikTokUrl(url) {
            return url.includes('tiktok.com') || url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com');
        }

        if (!isValidTikTokUrl(q)) {
            return await socket.sendMessage(sender, {
                text: '❌ *Invalid TikTok URL*\nPlease provide a valid TikTok URL.'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Fetch TikTok video info
        const TIKTOK_API_URL = 'https://dev-priyanshi.onrender.com/api/alldl';
        const apiUrl = `${TIKTOK_API_URL}?url=${encodeURIComponent(q)}`;
        
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.data?.status || !response.data.data) {
            throw new Error('Invalid API response');
        }

        const videoData = response.data.data;

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create buttons message
        const buttonsMessage = {
            image: { url: videoData.thumbnail },
            caption: `🎵 *TikTok Downloader*\n\n` +
                    `📌 *Title:* ${videoData.title || 'TikTok Video'}\n` +
                    `👤 *Creator:* ${videoData.author || 'Unknown'}\n` +
                    `🔄 *Quality Options Available*\n\n` +
                    `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
            footer: 'Select download option:',
            buttons: [
                {
                    buttonId: `tt-video-${sessionId}`,
                    buttonText: { displayText: '🎥 Video' },
                    type: 1
                },
                {
                    buttonId: `tt-audio-${sessionId}`,
                    buttonText: { displayText: '🔊 Audio' },
                    type: 1
                }
            ],
            headerType: 1
        };

        // Send message with buttons
        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        // Button handler
        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    // Remove listener
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const isVideo = buttonId.startsWith(`tt-video-${sessionId}`);
                        const mediaUrl = isVideo ? videoData.play : videoData.play;
                        
                        // Download the media
                        const mediaResponse = await axios.get(mediaUrl, {
                            responseType: 'arraybuffer',
                            timeout: 60000
                        });
                        
                        const mediaBuffer = Buffer.from(mediaResponse.data, 'binary');
                        
                        if (isVideo) {
                            const fileName = `${(videoData.title || 'tiktok_video').replace(/[<>:"\/\\|?*]+/g, '')}.mp4`;
                            await socket.sendMessage(sender, {
                                video: mediaBuffer,
                                caption: `🎵 *${videoData.title || 'TikTok Video'}*\n` +
                                        `👤 *Creator:* ${videoData.author || 'Unknown'}\n` +
                                        `🌐 *Source:* TikTok\n\n` +
                                        `>  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                                fileName: fileName
                            }, { quoted: messageData });
                        } else {
                            const fileName = `${(videoData.title || 'tiktok_audio').replace(/[<>:"\/\\|?*]+/g, '')}.mp3`;
                            await socket.sendMessage(sender, {
                                audio: mediaBuffer,
                                mimetype: 'audio/mpeg',
                                caption: `🔊 *${videoData.title || 'TikTok Audio'}*\n` +
                                        `👤 *Creator:* ${videoData.author || 'Unknown'}\n` +
                                        `🌐 *Source:* TikTok\n\n` +
                                        `>  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                                fileName: fileName
                            }, { quoted: messageData });
                        }

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('TikTok Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${error.message || 'Download failed'}`
                        }, { quoted: messageData });
                    }
                }
            } catch (error) {
                console.error('Button handler error:', error);
            }
        };

        // Add listener
        socket.ev.on('messages.upsert', buttonHandler);

        // Remove listener after 2 minutes
        setTimeout(() => {
            socket.ev.off('messages.upsert', buttonHandler);
        }, 120000);

    } catch (error) {
        console.error('TikTok Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to process TikTok video'}`
        }, { quoted: msg });
    }
    break;
}
//==============================
case 'song':
case 'ytaudio':
case 'play': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q || q.trim() === '') {
            return await socket.sendMessage(sender, {
                text: '🎵 *Usage:* .song <query/url>\nExample: .song https://youtu.be/ox4tmEV6-QU\n.song Alan Walker faded'
            }, { quoted: ai });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Utility function to fetch YouTube video info
        async function fetchVideoInfo(text) {
            const isYtUrl = text.match(/(youtube\.com|youtu\.be)/i);
            if (isYtUrl) {
                const videoId = text.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i)?.[1];
                if (!videoId) throw new Error('Invalid YouTube URL format');
                const videoInfo = await yts({ videoId });
                if (!videoInfo) throw new Error('Could not fetch video info');
                return { url: `https://youtu.be/${videoId}`, info: videoInfo };
            } else {
                const searchResults = await yts(text);
                if (!searchResults?.videos?.length) throw new Error('No results found');
                const validVideos = searchResults.videos.filter(v => !v.live && v.seconds < 7200 && v.views > 10000);
                if (!validVideos.length) throw new Error('Only found live streams/unpopular videos');
                return { url: validVideos[0].url, info: validVideos[0] };
            }
        }

        // Utility function to fetch audio from Hector's API
        async function fetchAudioData(videoUrl) {
            const HECTOR_API_URL = 'https://yt-dl.officialhectormanuel.workers.dev/';
            
            const apiUrl = `${HECTOR_API_URL}?url=${encodeURIComponent(videoUrl)}`;
            const response = await axios.get(apiUrl, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            
            if (!response.data?.status || !response.data?.audio) {
                throw new Error('Invalid API response or no audio available');
            }
            return response.data;
        }

        // Fetch video info
        const { url: videoUrl, info: videoInfo } = await fetchVideoInfo(q.trim());

        // Fetch audio data from Hector's API
        const songData = await fetchAudioData(videoUrl);

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Prepare caption
        const caption = `🎧 *${songData.title || videoInfo?.title || 'Unknown Title'}*\n\n` +
                       `⏱️ *Duration:* ${videoInfo?.timestamp || 'N/A'}\n` +
                       `👤 *Artist:* ${videoInfo?.author?.name || 'Unknown Artist'}\n` +
                       `👀 *Views:* ${(videoInfo?.views || 'N/A').toLocaleString()}\n\n` +
                       `🔗 *URL:* ${videoUrl}\n\n` +
                       `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Create buttons message
        const buttonsMessage = {
            image: { url: songData.thumbnail || videoInfo.thumbnail },
            caption: caption,
            footer: 'Select download format:',
            buttons: [
                {
                    buttonId: `song-audio-${sessionId}`,
                    buttonText: { displayText: '🎵 Audio (Play)' },
                    type: 1
                },
                {
                    buttonId: `song-document-${sessionId}`,
                    buttonText: { displayText: '📁 Document (Save)' },
                    type: 1
                }
            ],
            headerType: 1
        };

        // Send message with buttons
        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        // Button handler
        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    // Remove listener
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const type = buttonId.startsWith(`song-audio-${sessionId}`) ? 'audio' : 'document';
                        
                        // Download audio from Hector's API
                        const audioResponse = await axios.get(songData.audio, {
                            responseType: 'arraybuffer',
                            headers: { 
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Accept-Encoding': 'identity'
                            },
                            timeout: 30000 // Increased timeout for larger files
                        });

                        const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                        const fileName = `${(songData.title || videoInfo?.title || 'audio').replace(/[<>:"\/\\|?*]+/g, '')}.mp3`;

                        // Send audio based on user choice
                        if (type === 'audio') {
                            await socket.sendMessage(sender, {
                                audio: audioBuffer,
                                mimetype: 'audio/mpeg',
                                fileName: fileName,
                                ptt: false
                            }, { quoted: messageData });
                        } else {
                            await socket.sendMessage(sender, {
                                document: audioBuffer,
                                mimetype: 'audio/mpeg',
                                fileName: fileName
                            }, { quoted: messageData });
                        }

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('Song Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${error.message || 'Download failed'}\n\nTry again or use a different video.`
                        }, { quoted: messageData });
                    }
                }
            } catch (error) {
                console.error('Button handler error:', error);
            }
        };

        // Add listener
        socket.ev.on('messages.upsert', buttonHandler);

        // Remove listener after 2 minutes
        setTimeout(() => {
            socket.ev.off('messages.upsert', buttonHandler);
        }, 120000);

    } catch (error) {
        console.error('Song Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❎ Error: ${error.message || 'An unexpected error occurred'}\n\nPlease try again with a different video or check if the URL is valid.`
        }, { quoted: msg });
    }
    break;
}
//==============================
case 'ytmax':
case 'ytpro':
case 'ytvideo': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q || q.trim() === '') {
            return await socket.sendMessage(sender, {
                text: '🎬 *YTMax/YTPro Downloader*\n\n' +
                      '📥 *Usage:* .ytmax <query/url>\n' +
                      'Example: .ytmax https://youtu.be/ox4tmEV6-QU\n' +
                      'Example: .ytmax Alan Walker faded\n\n' +
                      '✨ *Features:* Downloads both video and audio in multiple qualities'
            }, { quoted: ai });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Utility function to fetch YouTube video info
        async function fetchVideoInfo(text) {
            const isYtUrl = text.match(/(youtube\.com|youtu\.be)/i);
            if (isYtUrl) {
                const videoId = text.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i)?.[1];
                if (!videoId) throw new Error('Invalid YouTube URL format');
                const videoInfo = await yts({ videoId });
                if (!videoInfo) throw new Error('Could not fetch video info');
                return { url: `https://youtu.be/${videoId}`, info: videoInfo };
            } else {
                const searchResults = await yts(text);
                if (!searchResults?.videos?.length) throw new Error('No results found');
                const validVideos = searchResults.videos.filter(v => !v.live && v.seconds < 10800 && v.views > 10000);
                if (!validVideos.length) throw new Error('Only found live streams/unpopular videos');
                return { url: validVideos[0].url, info: validVideos[0] };
            }
        }

        // Utility function to fetch data from Hector's API
        async function fetchMediaData(videoUrl) {
            const HECTOR_API_URL = 'https://yt-dl.officialhectormanuel.workers.dev/';
            
            const apiUrl = `${HECTOR_API_URL}?url=${encodeURIComponent(videoUrl)}`;
            const response = await axios.get(apiUrl, {
                timeout: 20000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            
            if (!response.data?.status) {
                throw new Error('Invalid API response or video not available');
            }
            return response.data;
        }

        // Fetch video info
        const { url: videoUrl, info: videoInfo } = await fetchVideoInfo(q.trim());

        // Fetch media data from Hector's API
        const mediaData = await fetchMediaData(videoUrl);

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Prepare caption
        const caption = `🎬 *${mediaData.title || videoInfo?.title || 'Unknown Title'}*\n\n` +
                       `⏱️ *Duration:* ${videoInfo?.timestamp || 'N/A'}\n` +
                       `👤 *Channel:* ${videoInfo?.author?.name || 'Unknown'}\n` +
                       `👀 *Views:* ${(videoInfo?.views || 'N/A').toLocaleString()}\n` +
                       `📊 *Qualities Available:* ${Object.keys(mediaData.videos || {}).length} video + audio\n\n` +
                       `🔗 *URL:* ${videoUrl}\n\n` +
                       `> © 𝙔𝙏𝙈𝙖𝙭 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        // Create quality selection buttons
        const buttons = [
            {
                buttonId: `ytmax-audio-${sessionId}`,
                buttonText: { displayText: '🎵 MP3 Audio' },
                type: 1
            }
        ];

        // Add video quality buttons
        if (mediaData.videos) {
            const qualities = Object.keys(mediaData.videos).sort((a, b) => parseInt(a) - parseInt(b));
            
            // Add first 3 qualities as buttons
            qualities.slice(0, 3).forEach(quality => {
                buttons.push({
                    buttonId: `ytmax-${quality}-${sessionId}`,
                    buttonText: { displayText: `📹 ${quality}p` },
                    type: 1
                });
            });

            // If more qualities available, add "More Qualities" button
            if (qualities.length > 3) {
                buttons.push({
                    buttonId: `ytmax-more-${sessionId}`,
                    buttonText: { displayText: '📋 More Qualities' },
                    type: 1
                });
            }
        }

        // Send main quality selection message
        const sentMsg = await socket.sendMessage(sender, {
            image: { url: mediaData.thumbnail || videoInfo.thumbnail },
            caption: caption,
            footer: 'Select download quality:',
            buttons: buttons,
            headerType: 1
        }, { quoted: msg });

        // Main button handler
        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    // Remove listener temporarily
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const action = buttonId.replace(`-${sessionId}`, '').replace('ytmax-', '');

                        if (action === 'audio') {
                            // Handle audio download
                            await downloadAndSendAudio(mediaData.audio, mediaData.title, messageData, false);
                            
                        } else if (action === 'more') {
                            // Show all available qualities
                            await showAllQualities(mediaData, videoInfo, videoUrl, messageData, sessionId);
                            
                        } else if (!isNaN(parseInt(action))) {
                            // Handle video quality download
                            const quality = action;
                            await downloadAndSendVideo(mediaData.videos[quality], quality, mediaData.title, messageData);
                            
                        }

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('YTMax Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Download Error: ${error.message || 'Failed to download media'}\n\nTry a different quality or video.`
                        }, { quoted: messageData });
                    } finally {
                        // Re-add listener for new interactions
                        socket.ev.on('messages.upsert', buttonHandler);
                    }
                }
            } catch (error) {
                console.error('Button handler error:', error);
            }
        };

        // Function to show all available qualities
        async function showAllQualities(mediaData, videoInfo, videoUrl, originalMsg, sessionId) {
            const allQualities = Object.keys(mediaData.videos || {}).sort((a, b) => parseInt(b) - parseInt(a));
            
            if (!allQualities.length) {
                return await socket.sendMessage(sender, {
                    text: '❌ No video qualities available for this video.'
                }, { quoted: originalMsg });
            }

            const qualityButtons = allQualities.map(quality => ({
                buttonId: `ytmax-quality-${quality}-${sessionId}`,
                buttonText: { displayText: `🎥 ${quality}p` },
                type: 1
            }));

            // Add audio button and back button
            qualityButtons.push(
                {
                    buttonId: `ytmax-quality-audio-${sessionId}`,
                    buttonText: { displayText: '🎵 MP3 Audio' },
                    type: 1
                },
                {
                    buttonId: `ytmax-back-${sessionId}`,
                    buttonText: { displayText: '↩️ Back' },
                    type: 1
                }
            );

            const qualityMessage = {
                text: `📋 *All Available Qualities for:*\n*${mediaData.title || videoInfo?.title}*\n\n` +
                      `🎵 *Audio:* MP3 Format\n` +
                      `🎥 *Videos:* ${allQualities.join('p, ')}p\n\n` +
                      `Select a quality to download:`,
                footer: 'YTMax Quality Selector',
                buttons: qualityButtons,
                headerType: 1
            };

            await socket.sendMessage(sender, qualityMessage, { quoted: originalMsg });
        }

        // Function to download and send audio
        async function downloadAndSendAudio(audioUrl, title, originalMsg, asDocument = false) {
            const audioResponse = await axios.get(audioUrl, {
                responseType: 'arraybuffer',
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Encoding': 'identity'
                },
                timeout: 45000
            });

            const audioBuffer = Buffer.from(audioResponse.data, 'binary');
            const fileName = `${(title || 'audio').replace(/[<>:"\/\\|?*]+/g, '')}.mp3`;

            if (asDocument) {
                await socket.sendMessage(sender, {
                    document: audioBuffer,
                    mimetype: 'audio/mpeg',
                    fileName: fileName
                }, { quoted: originalMsg });
            } else {
                await socket.sendMessage(sender, {
                    audio: audioBuffer,
                    mimetype: 'audio/mpeg',
                    fileName: fileName,
                    ptt: false
                }, { quoted: originalMsg });
            }
        }

        // Function to download and send video
        async function downloadAndSendVideo(videoUrl, quality, title, originalMsg) {
            const videoResponse = await axios.get(videoUrl, {
                responseType: 'arraybuffer',
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Encoding': 'identity'
                },
                timeout: 60000
            });

            const videoBuffer = Buffer.from(videoResponse.data, 'binary');
            const fileName = `${(title || 'video').replace(/[<>:"\/\\|?*]+/g, '')}_${quality}p.mp4`;

            await socket.sendMessage(sender, {
                video: videoBuffer,
                mimetype: 'video/mp4',
                fileName: fileName,
                caption: `🎥 *${title}*\n📹 Quality: ${quality}p\n⬇️ Downloaded via YTMax`
            }, { quoted: originalMsg });
        }

        // Quality selection handler
        const qualityHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                
                if (buttonId.includes(`ytmax-quality-`) && buttonId.includes(sessionId)) {
                    socket.ev.off('messages.upsert', qualityHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const action = buttonId.replace(`ytmax-quality-`, '').replace(`-${sessionId}`, '');

                        if (action === 'audio') {
                            await downloadAndSendAudio(mediaData.audio, mediaData.title, messageData, false);
                        } else if (action === 'back') {
                            // Go back to main menu (re-trigger original message)
                            await socket.sendMessage(sender, {
                                react: { text: '↩️', key: messageData.key }
                            });
                        } else if (!isNaN(parseInt(action))) {
                            await downloadAndSendVideo(mediaData.videos[action], action, mediaData.title, messageData);
                        }

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('Quality Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${error.message || 'Download failed'}`
                        }, { quoted: messageData });
                    }
                }
            } catch (error) {
                console.error('Quality handler error:', error);
            }
        };

        // Add listeners
        socket.ev.on('messages.upsert', buttonHandler);
        socket.ev.on('messages.upsert', qualityHandler);

        // Remove listeners after 3 minutes
        setTimeout(() => {
            socket.ev.off('messages.upsert', buttonHandler);
            socket.ev.off('messages.upsert', qualityHandler);
        }, 180000);

    } catch (error) {
        console.error('YTMax Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❎ YTMax Error: ${error.message || 'An unexpected error occurred'}\n\nPlease try again with a different video or check the URL.`
        }, { quoted: msg });
    }
    break;
}

// ==================== VIDEO DOWNLOAD (BUTTONED) ====================
case 'video':
case 'vid': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '🎬 *Video Downloader*\n\nPlease provide a video URL or search query.\nExample: .video https://youtube.com/watch?v=ABC123'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        let videoUrl = q;
        let isSearch = false;

        // Check if it's a search query (not a URL)
        function isUrl(text) {
            try {
                new URL(text);
                return true;
            } catch (e) {
                return false;
            }
        }

        if (!isUrl(q)) {
            isSearch = true;
            // Search YouTube for the query
            const searchResults = await yts(q);
            if (!searchResults.videos || searchResults.videos.length === 0) {
                throw new Error('No videos found for your search');
            }
            videoUrl = searchResults.videos[0].url;
        }

        // Fetch video info
        const VIDEO_API_URL = 'https://dev-priyanshi.onrender.com/api/alldl';
        const apiUrl = `${VIDEO_API_URL}?url=${encodeURIComponent(videoUrl)}`;
        
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.data?.status || !response.data.data) {
            throw new Error('Invalid API response');
        }

        const videoData = response.data.data;

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create buttons message
        let caption = `🎬 *Video Downloader*\n\n` +
                     `📌 *Title:* ${videoData.title || 'Video'}\n`;
        
        if (isSearch) {
            caption += `🔍 *Searched for:* "${q}"\n`;
        }
        
        caption += `🔄 *Quality Options Available*\n\n` +
                 `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        const buttonsMessage = {
            image: { url: videoData.thumbnail },
            caption: caption,
            footer: 'Select download quality:',
            buttons: [
                {
                    buttonId: `video-high-${sessionId}`,
                    buttonText: { displayText: '🎥 High Quality' },
                    type: 1
                },
                {
                    buttonId: `video-low-${sessionId}`,
                    buttonText: { displayText: '📱 Low Quality' },
                    type: 1
                }
            ],
            headerType: 1
        };

        // Send message with buttons
        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        // Button handler
        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    // Remove listener
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    try {
                        const isHighQuality = buttonId.startsWith(`video-high-${sessionId}`);
                        const selectedVideoUrl = isHighQuality ? videoData.high : videoData.low;
                        
                        // Download the video
                        const videoResponse = await axios.get(selectedVideoUrl, {
                            responseType: 'arraybuffer',
                            timeout: 60000
                        });
                        
                        const videoBuffer = Buffer.from(videoResponse.data, 'binary');
                        const fileName = `${(videoData.title || 'video').replace(/[<>:"\/\\|?*]+/g, '')}.mp4`;

                        // Send video
                        await socket.sendMessage(sender, {
                            video: videoBuffer,
                            caption: `🎬 *${videoData.title || 'Video'}*\n` +
                                    `📏 *Quality:* ${isHighQuality ? 'High' : 'Low'}\n` +
                                    (isSearch ? `🔍 *Searched:* "${q}"\n\n` : '\n') +
                                    `>  © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                            fileName: fileName
                        }, { quoted: messageData });

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    } catch (error) {
                        console.error('Video Download Error:', error);
                        await socket.sendMessage(sender, { react: { text: '❌', key: messageData.key } });
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${error.message || 'Download failed'}`
                        }, { quoted: messageData });
                    }
                }
            } catch (error) {
                console.error('Button handler error:', error);
            }
        };

        // Add listener
        socket.ev.on('messages.upsert', buttonHandler);

        // Remove listener after 2 minutes
        setTimeout(() => {
            socket.ev.off('messages.upsert', buttonHandler);
        }, 120000);

    } catch (error) {
        console.error('Video Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to process video'}`
        }, { quoted: msg });
    }
    break;
}
//-----
// ==================== SAVE MEDIA COMMAND ====================
case 'save':
case 'keep':
case 'lol':
case 'nice':
case 'vv':
case 'rvo':
case 'viewonce':
case '🔥': {
    try {
        // Check if message has quoted media
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) {
            return await socket.sendMessage(sender, {
                text: '❗ Please reply to a media message (image, video, audio, sticker) with .save'
            }, { quoted: msg });
        }

        // Get the actual media message from the quoted message
        const mimeType = getContentType(quotedMsg);
        const mediaMessage = quotedMsg[mimeType];
        
        if (!mimeType || !(mimeType.includes('image') || mimeType.includes('video') || mimeType.includes('audio') || mimeType.includes('sticker'))) {
            return await socket.sendMessage(sender, {
                text: '❗ Only images, videos, audio, and stickers are supported'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Determine media type
        let mediaType = mimeType.replace('Message', '').toLowerCase(); // imageMessage -> image
        
        // Download the media
        let mediaBuffer;
        try {
            const stream = await downloadContentFromMessage(mediaMessage, mediaType);
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            mediaBuffer = Buffer.concat(chunks);
        } catch (error) {
            console.error('Media download error:', error);
            return await socket.sendMessage(sender, {
                text: '❌ Failed to download media. Please try again.'
            }, { quoted: msg });
        }

        // Get caption from quoted message if available
        let caption = '';
        if (mediaMessage.caption) {
            caption = mediaMessage.caption;
        }

        // Send the media back to the user
        switch (mediaType) {
            case 'image':
                await socket.sendMessage(sender, {
                    image: mediaBuffer,
                    caption: caption || '✅ Saved image',
                    contextInfo: {
                        mentionedJid: [sender]
                    }
                }, { quoted: msg });
                break;
                
            case 'video':
                await socket.sendMessage(sender, {
                    video: mediaBuffer,
                    caption: caption || '✅ Saved video',
                    contextInfo: {
                        mentionedJid: [sender]
                    }
                }, { quoted: msg });
                break;
                
            case 'audio':
                await socket.sendMessage(sender, {
                    audio: mediaBuffer,
                    mimetype: 'audio/mp4',
                    ptt: false,
                    contextInfo: {
                        mentionedJid: [sender]
                    }
                }, { quoted: msg });
                break;
                
            case 'sticker':
                await socket.sendMessage(sender, {
                    sticker: mediaBuffer,
                    contextInfo: {
                        mentionedJid: [sender]
                    }
                }, { quoted: msg });
                break;
                
            default:
                return await socket.sendMessage(sender, {
                    text: '❌ Unsupported media type'
                }, { quoted: msg });
        }

        // Send success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('Save command error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to save media'}`
        }, { quoted: msg });
    }
    break;
}

// ==================== TOURL (MEDIA TO URL) - FIXED VERSION ====================

case 'pinterest':
case 'pin':
case 'image':
case 'img': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q || q.trim() === '') {
            return await socket.sendMessage(sender, {
                text: '🖼️ *Image Downloader*\n\nPlease provide a search query.\nExample: .pinterest scooby doo 10\n\nYou can specify number of images (default: 5)'
            }, { quoted: msg });
        }

        // Parse query and count
        const parts = q.trim().split(' ');
        let searchQuery = '';
        let imageCount = 5; // Default count

        if (parts.length > 1 && !isNaN(parseInt(parts[parts.length - 1]))) {
            // Last part is a number
            imageCount = parseInt(parts.pop());
            searchQuery = parts.join(' ');
        } else {
            searchQuery = q.trim();
        }

        // Validate count
        imageCount = Math.min(Math.max(imageCount, 1), 20); // Limit to 1-20 images

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Call Pinterest API
        const apiUrl = `https://supun-md-api-xmjh.vercel.app/api/pinterest-search?q=${encodeURIComponent(searchQuery)}`;
        
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.data?.success || !response.data.results?.data) {
            throw new Error('No images found or API error');
        }

        const images = response.data.results.data;
        const totalImages = Math.min(imageCount, images.length);

        if (totalImages === 0) {
            throw new Error('No images found for your search');
        }

        // Generate unique session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create buttons message
        const buttonsMessage = {
            image: { url: images[0] }, // First image as preview
            caption: `🖼️ *Pinterest Image Downloader*\n\n` +
                    `🔍 *Search:* "${searchQuery}"\n` +
                    `📊 *Found:* ${images.length} images\n` +
                    `📦 *Downloading:* ${totalImages} images\n\n` +
                    `> Powered by Supun API`,
            footer: 'Select download option:',
            buttons: [
                {
                    buttonId: `pin-all-${sessionId}-${totalImages}`,
                    buttonText: { displayText: `📦 All ${totalImages} Images` },
                    type: 1
                },
                {
                    buttonId: `pin-single-${sessionId}`,
                    buttonText: { displayText: '🖼️ Single Image' },
                    type: 1
                },
                {
                    buttonId: `pin-custom-${sessionId}`,
                    buttonText: { displayText: '🔢 Custom Amount' },
                    type: 1
                }
            ],
            headerType: 1
        };

        // Send message with buttons
        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        // Store image data for reply handling
        if (!global.imageDownloads) global.imageDownloads = new Map();
        global.imageDownloads.set(sender, {
            images: images,
            searchQuery: searchQuery,
            totalAvailable: images.length,
            requestedCount: totalImages,
            sessionId: sessionId,
            timestamp: Date.now()
        });

        // Set timeout to clear stored data after 5 minutes
        setTimeout(() => {
            if (global.imageDownloads && global.imageDownloads.has(sender)) {
                global.imageDownloads.delete(sender);
            }
        }, 300000);

    } catch (error) {
        console.error('Pinterest Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || 'Failed to search for images'}`
        }, { quoted: msg });
    }
    break;
}

// Add this to handle Pinterest button responses
socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message.message || !global.imageDownloads) return;

    const senderJid = message.key.remoteJid;
    const body = message.message.conversation || message.message.extendedTextMessage?.text || '';
    
    const imageData = global.imageDownloads.get(senderJid);
    if (!imageData || (Date.now() - imageData.timestamp) > 300000) {
        if (global.imageDownloads.has(senderJid)) {
            global.imageDownloads.delete(senderJid);
        }
        return;
    }

    try {
        if (message.message.buttonsResponseMessage) {
            // Handle button clicks
            const buttonId = message.message.buttonsResponseMessage.selectedButtonId;
            
            if (buttonId.startsWith(`pin-all-${imageData.sessionId}`)) {
                // Download all requested images
                await socket.sendMessage(senderJid, { 
                    text: `📦 Downloading ${imageData.requestedCount} images...` 
                }, { quoted: message });

                const imagesToSend = imageData.images.slice(0, imageData.requestedCount);
                
                for (let i = 0; i < imagesToSend.length; i++) {
                    try {
                        await socket.sendMessage(senderJid, {
                            image: { url: imagesToSend[i] },
                            caption: `🖼️ *Image ${i + 1}/${imageData.requestedCount}*\n` +
                                    `🔍 "${imageData.searchQuery}"\n\n` +
                                    `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                        });
                        await delay(1000); // Delay between images to avoid rate limiting
                    } catch (imgError) {
                        console.error('Failed to send image:', imgError);
                    }
                }

                await socket.sendMessage(senderJid, { 
                    text: `✅ Successfully sent ${imagesToSend.length} images!` 
                }, { quoted: message });

            } else if (buttonId.startsWith(`pin-single-${imageData.sessionId}`)) {
                // Send single random image
                const randomImage = imageData.images[Math.floor(Math.random() * imageData.images.length)];
                
                await socket.sendMessage(senderJid, {
                    image: { url: randomImage },
                    caption: `🖼️ *Random Image*\n` +
                            `🔍 "${imageData.searchQuery}"\n\n` +
                            `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                }, { quoted: message });

            } else if (buttonId.startsWith(`pin-custom-${imageData.sessionId}`)) {
                // Ask for custom amount
                await socket.sendMessage(senderJid, {
                    text: `🔢 *Custom Image Amount*\n\n` +
                          `Available: ${imageData.totalAvailable} images\n` +
                          `Please reply with how many images you want (1-${Math.min(imageData.totalAvailable, 20)})`
                }, { quoted: message });

                // Store state for custom amount input
                if (!global.customImageAmount) global.customImageAmount = new Map();
                global.customImageAmount.set(senderJid, {
                    images: imageData.images,
                    searchQuery: imageData.searchQuery,
                    timestamp: Date.now()
                });

            }
            
            // Clear the image data after processing
            global.imageDownloads.delete(senderJid);

        } else if (global.customImageAmount && global.customImageAmount.has(senderJid)) {
            // Handle custom amount input
            const customData = global.customImageAmount.get(senderJid);
            if ((Date.now() - customData.timestamp) > 120000) {
                global.customImageAmount.delete(senderJid);
                return;
            }

            const amount = parseInt(body.trim());
            if (isNaN(amount) || amount < 1 || amount > Math.min(customData.images.length, 20)) {
                await socket.sendMessage(senderJid, {
                    text: `❌ Please enter a number between 1 and ${Math.min(customData.images.length, 20)}`
                }, { quoted: message });
                return;
            }

            await socket.sendMessage(senderJid, { 
                text: `📦 Downloading ${amount} images...` 
            }, { quoted: message });

            const imagesToSend = customData.images.slice(0, amount);
            
            for (let i = 0; i < imagesToSend.length; i++) {
                try {
                    await socket.sendMessage(senderJid, {
                        image: { url: imagesToSend[i] },
                        caption: `🖼️ *Image ${i + 1}/${amount}*\n` +
                                `🔍 "${customData.searchQuery}"\n\n` +
                                `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                    });
                    await delay(1000); // Delay between images
                } catch (imgError) {
                    console.error('Failed to send image:', imgError);
                }
            }

            await socket.sendMessage(senderJid, { 
                text: `✅ Successfully sent ${imagesToSend.length} images!` 
            }, { quoted: message });

            global.customImageAmount.delete(senderJid);
        }

    } catch (error) {
        console.error('Image download handler error:', error);
        await socket.sendMessage(senderJid, {
            text: '❌ Error processing your request'
        }, { quoted: message });
        
        // Clean up
        if (global.imageDownloads.has(senderJid)) global.imageDownloads.delete(senderJid);
        if (global.customImageAmount && global.customImageAmount.has(senderJid)) {
            global.customImageAmount.delete(senderJid);
        }
    }
});

// Helper function for delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//==============================//==============================
  case 'ai2': {
    try {
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q || q.trim() === '') {
            return await socket.sendMessage(sender, {
                text: '🤖 *Venice AI*\n\nPlease provide a question or message.\nExample: .ai What is artificial intelligence?'
            }, { quoted: msg });
        }

        // Send processing reaction
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Call Venice AI API
        const apiUrl = `https://api-toxxic.zone.id/api/ai/venice?prompt=${encodeURIComponent(q)}`;
        
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        // Send the AI response directly
        await socket.sendMessage(sender, {
            text: `🤖 *Venice AI*\n\n${response.data.data}`
        }, { quoted: msg });

        // Add success reaction
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('AI Command Error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}           
// ####

// ==================== ANTICALL COMMAND ====================
case 'anticall':
case 'antical': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "*📛 Only the owner can use this command!*"
        }, { quoted: msg });

        const userConfig = await loadUserConfig(sanitizedNumber);
        const currentStatus = userConfig.ANTICALL || 'false';
        const isEnabled = currentStatus === 'true';
        const option = args[0]?.toLowerCase();

        if (!option) {
            const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            const buttonsMessage = {
                image: { url: config.RCD_IMAGE_PATH },
                caption: `📵 *ANTI-CALL SETTINGS*\n\nCurrent Status: ${isEnabled ? '✅ ENABLED' : '❌ DISABLED'}\n\nSelect an option:\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                footer: 'Toggle anti-call feature',
                buttons: [
                    {
                        buttonId: `anticall-enable-${sessionId}`,
                        buttonText: { displayText: '✅ ENABLE' },
                        type: 1
                    },
                    {
                        buttonId: `anticall-disable-${sessionId}`,
                        buttonText: { displayText: '❌ DISABLE' },
                        type: 1
                    },
                    {
                        buttonId: `anticall-status-${sessionId}`,
                        buttonText: { displayText: '📊 STATUS' },
                        type: 1
                    }
                ],
                headerType: 1
            };

            const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

            const buttonHandler = async (messageUpdate) => {
                try {
                    const messageData = messageUpdate?.messages[0];
                    if (!messageData?.message?.buttonsResponseMessage) return;

                    const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                    const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                    if (isReplyToBot && buttonId.includes(sessionId)) {
                        socket.ev.off('messages.upsert', buttonHandler);

                        await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                        const updatedConfig = await loadUserConfig(sanitizedNumber);

                        if (buttonId.startsWith(`anticall-enable-${sessionId}`)) {
                            updatedConfig.ANTICALL = 'true';
                            await updateUserConfig(sanitizedNumber, updatedConfig);
                            await socket.sendMessage(sender, {
                                text: "✅ *Anti-call feature enabled*\n\nAll incoming calls will be automatically rejected.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
                            }, { quoted: messageData });
                        } 
                        else if (buttonId.startsWith(`anticall-disable-${sessionId}`)) {
                            updatedConfig.ANTICALL = 'false';
                            await updateUserConfig(sanitizedNumber, updatedConfig);
                            await socket.sendMessage(sender, {
                                text: "❌ *Anti-call feature disabled*\n\nIncoming calls will not be automatically rejected.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊�Federal𝘾 ッ"
                            }, { quoted: messageData });
                        }
                        else if (buttonId.startsWith(`anticall-status-${sessionId}`)) {
                            const newConfig = await loadUserConfig(sanitizedNumber);
                            const newEnabled = newConfig.ANTICALL === 'true';
                            await socket.sendMessage(sender, {
                                text: `📊 *Anti-call Status:* ${newEnabled ? '✅ ENABLED' : '❌ DISABLED'}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                            }, { quoted: messageData });
                        }

                        await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                    }
                } catch (error) {
                    console.error('Button handler error:', error);
                }
            };

            socket.ev.on('messages.upsert', buttonHandler);
            setTimeout(() => socket.ev.off('messages.upsert', buttonHandler), 120000);

        } else {
            if (option === "on" || option === "true") {
                userConfig.ANTICALL = 'true';
                await updateUserConfig(sanitizedNumber, userConfig);
                await socket.sendMessage(sender, {
                    text: "✅ *Anti-call feature enabled*\n\nAll incoming calls will be automatically rejected.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
                }, { quoted: msg });
            } else if (option === "off" || option === "false") {
                userConfig.ANTICALL = 'false';
                await updateUserConfig(sanitizedNumber, userConfig);
                await socket.sendMessage(sender, {
                    text: "❌ *Anti-call feature disabled*\n\nIncoming calls will not be automatically rejected.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
                }, { quoted: msg });
            } else {
                await socket.sendMessage(sender, {
                    text: "❌ Invalid option! Use `.anticall on` or `.anticall off`"
                }, { quoted: msg });
            }
        }

    } catch (error) {
        console.error('Anticall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== MODE COMMAND ====================
case 'mode': {
    try {
        const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isBotOwner = nowsender === botOwnerJid;
        let sudoUsers = [];
        try {
            sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        } catch {}
        const isSudoUser = sudoUsers.includes(nowsender);
        
        if (!isOwner && !isBotOwner && !isSudoUser) {
            return await socket.sendMessage(sender, {
                text: "*📛 Only the bot owner or sudo users can change mode!*"
            }, { quoted: msg });
        }

        const userConfig = await loadUserConfig(sanitizedNumber);
        const newMode = args[0]?.toLowerCase();
        
        if (!newMode || !['public', 'private'].includes(newMode)) {
            return await socket.sendMessage(sender, {
                text: `🔐 *Current Mode:* ${(userConfig.MODE || config.MODE).toUpperCase()}\n\n*Usage:* .mode public OR .mode private\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
            }, { quoted: msg });
        }

        userConfig.MODE = newMode;
        await updateUserConfig(sanitizedNumber, userConfig);
        await socket.sendMessage(sender, {
            text: `🔐 *Mode Changed to ${newMode.toUpperCase()}*\n\n${newMode === 'private' ? '🔒 Only sudo users can use the bot.' : '🔓 Everyone can use the bot.'}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: msg });
    } catch (error) {
        console.error('Mode command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== SET PREFIX COMMAND ====================
case 'setprefix':
case 'prefix': {
    try {
        const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isBotOwner = nowsender === botOwnerJid;
        let sudoUsers = [];
        try {
            sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        } catch {}
        const isSudoUser = sudoUsers.includes(nowsender);
        
        if (!isOwner && !isBotOwner && !isSudoUser) {
            return await socket.sendMessage(sender, {
                text: "*📛 Only the bot owner or sudo users can change prefix!*"
            }, { quoted: msg });
        }

        const userConfig = await loadUserConfig(sanitizedNumber);
        const newPrefix = args[0];
        
        if (!newPrefix) {
            return await socket.sendMessage(sender, {
                text: `📌 *Current Prefix:* ${userConfig.PREFIX || config.PREFIX}\n\n*Usage:* .setprefix ! \n*Examples:* .setprefix # OR .setprefix / \n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
            }, { quoted: msg });
        }

        if (newPrefix.length > 3) {
            return await socket.sendMessage(sender, {
                text: "❌ Prefix must be 1-3 characters only!"
            }, { quoted: msg });
        }

        userConfig.PREFIX = newPrefix;
        await updateUserConfig(sanitizedNumber, userConfig);
        await socket.sendMessage(sender, {
            text: `📌 *Prefix Changed to:* ${newPrefix}\n\nAll commands now use this prefix.\n*Example:* ${newPrefix}menu\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: msg });
    } catch (error) {
        console.error('Setprefix command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== SET AUTO RECORDING COMMAND ====================
case 'setautorecording':
case 'autorecording': {
    try {
        const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isBotOwner = nowsender === botOwnerJid;
        let sudoUsers = [];
        try {
            sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        } catch {}
        const isSudoUser = sudoUsers.includes(nowsender);
        
        if (!isOwner && !isBotOwner && !isSudoUser) {
            return await socket.sendMessage(sender, {
                text: "*📛 Only the bot owner or sudo users can change this setting!*"
            }, { quoted: msg });
        }

        const userConfig = await loadUserConfig(sanitizedNumber);
        const option = args[0]?.toLowerCase();
        
        if (!option || !['on', 'off', 'true', 'false'].includes(option)) {
            return await socket.sendMessage(sender, {
                text: `🎙️ *Auto Recording:* ${(userConfig.AUTO_RECORDING || config.AUTO_RECORDING) === 'true' ? '✅ ON' : '❌ OFF'}\n\n*Usage:* .setautorecording on OR .setautorecording off\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
            }, { quoted: msg });
        }

        const enabled = (option === 'on' || option === 'true');
        userConfig.AUTO_RECORDING = enabled ? 'true' : 'false';
        await updateUserConfig(sanitizedNumber, userConfig);
        await socket.sendMessage(sender, {
            text: `🎙️ *Auto Recording ${enabled ? 'Enabled' : 'Disabled'}*\n\n${enabled ? 'Bot will show recording status when processing commands.' : 'Recording status disabled.'}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: msg });
    } catch (error) {
        console.error('Auto recording command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== AUTO VIEW STATUS COMMAND ====================
case 'autoviewstatus':
case 'viewstatus': {
    try {
        const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isBotOwner = nowsender === botOwnerJid;
        let sudoUsers = [];
        try {
            sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        } catch {}
        const isSudoUser = sudoUsers.includes(nowsender);
        
        if (!isOwner && !isBotOwner && !isSudoUser) {
            return await socket.sendMessage(sender, {
                text: "*📛 Only the bot owner or sudo users can change this setting!*"
            }, { quoted: msg });
        }

        const userConfig = await loadUserConfig(sanitizedNumber);
        const option = args[0]?.toLowerCase();
        
        if (!option || !['on', 'off', 'true', 'false'].includes(option)) {
            return await socket.sendMessage(sender, {
                text: `👁️ *Auto View Status:* ${(userConfig.AUTO_VIEW_STATUS || config.AUTO_VIEW_STATUS) === 'true' ? '✅ ON' : '❌ OFF'}\n\n*Usage:* .autoviewstatus on OR .autoviewstatus off\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
            }, { quoted: msg });
        }

        const enabled = (option === 'on' || option === 'true');
        userConfig.AUTO_VIEW_STATUS = enabled ? 'true' : 'false';
        await updateUserConfig(sanitizedNumber, userConfig);
        await socket.sendMessage(sender, {
            text: `👁️ *Auto View Status ${enabled ? 'Enabled' : 'Disabled'}*\n\n${enabled ? 'Bot will automatically view all status updates.' : 'Auto view disabled.'}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: msg });
    } catch (error) {
        console.error('Auto view status command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== AUTO REACT STATUS COMMAND ====================
case 'autoreactstatus':
case 'reactstatus': {
    try {
        const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isBotOwner = nowsender === botOwnerJid;
        let sudoUsers = [];
        try {
            sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        } catch {}
        const isSudoUser = sudoUsers.includes(nowsender);
        
        if (!isOwner && !isBotOwner && !isSudoUser) {
            return await socket.sendMessage(sender, {
                text: "*📛 Only the bot owner or sudo users can change this setting!*"
            }, { quoted: msg });
        }

        const userConfig = await loadUserConfig(sanitizedNumber);
        const option = args[0]?.toLowerCase();
        
        if (!option || !['on', 'off', 'true', 'false'].includes(option)) {
            return await socket.sendMessage(sender, {
                text: `❤️ *Auto React Status:* ${(userConfig.AUTO_LIKE_STATUS || config.AUTO_LIKE_STATUS) === 'true' ? '✅ ON' : '❌ OFF'}\n\n*Usage:* .autoreactstatus on OR .autoreactstatus off\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
            }, { quoted: msg });
        }

        const enabled = (option === 'on' || option === 'true');
        userConfig.AUTO_LIKE_STATUS = enabled ? 'true' : 'false';
        await updateUserConfig(sanitizedNumber, userConfig);
        await socket.sendMessage(sender, {
            text: `❤️ *Auto React Status ${enabled ? 'Enabled' : 'Disabled'}*\n\n${enabled ? 'Bot will automatically react to all status updates.' : 'Auto react disabled.'}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙖𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
        }, { quoted: msg });
    } catch (error) {
        console.error('Auto react status command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== SETTINGS COMMAND ====================
case 'settings':
case 'setting':
case 'config': {
    try {
        // Bot number is always owner
        const botOwnerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isBotOwner = nowsender === botOwnerJid;
        
        // Check if user is owner (config owner OR bot number itself OR sudo user)
        let sudoUsers = [];
        try {
            sudoUsers = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        } catch {}
        const isSudoUser = sudoUsers.includes(nowsender);
        
        if (!isOwner && !isBotOwner && !isSudoUser) {
            return await socket.sendMessage(sender, {
                text: "*📛 Only the bot owner or sudo users can access settings!*"
            }, { quoted: msg });
        }

        const userConfig = await loadUserConfig(sanitizedNumber);
        const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const currentSettings = `⚙️ *BOT SETTINGS*\n\n` +
                               `📌 *PREFIX:* ${userConfig.PREFIX || config.PREFIX}\n` +
                               `🔐 *MODE:* ${(userConfig.MODE || config.MODE).toUpperCase()}\n` +
                               `👁️ *AUTO VIEW STATUS:* ${(userConfig.AUTO_VIEW_STATUS || config.AUTO_VIEW_STATUS) === 'true' ? '✅' : '❌'}\n` +
                               `❤️ *AUTO REACT STATUS:* ${(userConfig.AUTO_LIKE_STATUS || config.AUTO_LIKE_STATUS) === 'true' ? '✅' : '❌'}\n` +
                               `📵 *ANTI-CALL:* ${(userConfig.ANTICALL || config.ANTICALL) === 'true' ? '✅' : '❌'}\n` +
                               `🎙️ *AUTO RECORDING:* ${(userConfig.AUTO_RECORDING || config.AUTO_RECORDING) === 'true' ? '✅' : '❌'}\n\n` +
                               `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        const buttonsMessage = {
            image: { url: config.RCD_IMAGE_PATH },
            caption: currentSettings,
            footer: 'Select a setting to configure',
            buttons: [
                {
                    buttonId: `settings-menu-${sessionId}`,
                    buttonText: { displayText: '📋 All Settings' },
                    type: 1
                },
                {
                    buttonId: `settings-mode-${sessionId}`,
                    buttonText: { displayText: '🔐 Toggle Mode' },
                    type: 1
                },
                {
                    buttonId: `settings-prefix-${sessionId}`,
                    buttonText: { displayText: '📌 Change Prefix' },
                    type: 1
                }
            ],
            headerType: 1
        };

        const sentMsg = await socket.sendMessage(sender, buttonsMessage, { quoted: msg });

        const buttonHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;
                const isReplyToBot = messageData.message.buttonsResponseMessage.contextInfo?.stanzaId === sentMsg.key.id;

                if (isReplyToBot && buttonId.includes(sessionId)) {
                    socket.ev.off('messages.upsert', buttonHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    const updatedConfig = await loadUserConfig(sanitizedNumber);

                    if (buttonId.startsWith(`settings-menu-${sessionId}`)) {
                        // Show all settings menu
                        const allSettingsMsg = {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: currentSettings,
                            footer: 'Configure individual settings',
                            buttons: [
                                {
                                    buttonId: `setting-viewstatus-${sessionId}`,
                                    buttonText: { displayText: '👁️ Auto View Status' },
                                    type: 1
                                },
                                {
                                    buttonId: `setting-reactstatus-${sessionId}`,
                                    buttonText: { displayText: '❤️ Auto React Status' },
                                    type: 1
                                },
                                {
                                    buttonId: `setting-recording-${sessionId}`,
                                    buttonText: { displayText: '🎙️ Auto Recording' },
                                    type: 1
                                }
                            ],
                            headerType: 1
                        };
                        await socket.sendMessage(sender, allSettingsMsg, { quoted: messageData });
                        
                        // Re-add listener for sub-settings
                        socket.ev.on('messages.upsert', subSettingsHandler);
                        setTimeout(() => socket.ev.off('messages.upsert', subSettingsHandler), 120000);
                        
                    } else if (buttonId.startsWith(`settings-mode-${sessionId}`)) {
                        // Toggle mode
                        const currentMode = updatedConfig.MODE || config.MODE;
                        updatedConfig.MODE = currentMode === 'public' ? 'private' : 'public';
                        await updateUserConfig(sanitizedNumber, updatedConfig);
                        await socket.sendMessage(sender, {
                            text: `🔐 *Mode Changed*\n\nBot is now in *${updatedConfig.MODE.toUpperCase()}* mode.\n\n${updatedConfig.MODE === 'private' ? '🔒 Only sudo users can use the bot.' : '🔓 Everyone can use the bot.'}\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                        }, { quoted: messageData });
                        
                    } else if (buttonId.startsWith(`settings-prefix-${sessionId}`)) {
                        // Change prefix - ask for input
                        await socket.sendMessage(sender, {
                            text: `📌 *Change Prefix*\n\nReply with your desired prefix.\n\n*Current:* ${updatedConfig.PREFIX || config.PREFIX}\n*Example:* ! or # or /\n\n_Reply within 60 seconds_`
                        }, { quoted: messageData });
                        
                        // Store pending prefix change
                        if (!global.pendingPrefixChange) global.pendingPrefixChange = new Map();
                        global.pendingPrefixChange.set(nowsender, {
                            number: sanitizedNumber,
                            timestamp: Date.now()
                        });
                    }

                    await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                }
            } catch (error) {
                console.error('Settings button handler error:', error);
            }
        };

        // Sub-settings handler
        const subSettingsHandler = async (messageUpdate) => {
            try {
                const messageData = messageUpdate?.messages[0];
                if (!messageData?.message?.buttonsResponseMessage) return;

                const buttonId = messageData.message.buttonsResponseMessage.selectedButtonId;

                if (buttonId.includes(sessionId)) {
                    socket.ev.off('messages.upsert', subSettingsHandler);

                    await socket.sendMessage(sender, { react: { text: '⏳', key: messageData.key } });

                    const updatedConfig = await loadUserConfig(sanitizedNumber);

                    if (buttonId.startsWith(`setting-viewstatus-${sessionId}`)) {
                        updatedConfig.AUTO_VIEW_STATUS = updatedConfig.AUTO_VIEW_STATUS === 'true' ? 'false' : 'true';
                        await updateUserConfig(sanitizedNumber, updatedConfig);
                        await socket.sendMessage(sender, {
                            text: `👁️ *Auto View Status ${updatedConfig.AUTO_VIEW_STATUS === 'true' ? 'Enabled' : 'Disabled'}*\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                        }, { quoted: messageData });
                    } else if (buttonId.startsWith(`setting-reactstatus-${sessionId}`)) {
                        updatedConfig.AUTO_LIKE_STATUS = updatedConfig.AUTO_LIKE_STATUS === 'true' ? 'false' : 'true';
                        await updateUserConfig(sanitizedNumber, updatedConfig);
                        await socket.sendMessage(sender, {
                            text: `❤️ *Auto React Status ${updatedConfig.AUTO_LIKE_STATUS === 'true' ? 'Enabled' : 'Disabled'}*\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                        }, { quoted: messageData });
                    } else if (buttonId.startsWith(`setting-recording-${sessionId}`)) {
                        updatedConfig.AUTO_RECORDING = updatedConfig.AUTO_RECORDING === 'true' ? 'false' : 'true';
                        await updateUserConfig(sanitizedNumber, updatedConfig);
                        await socket.sendMessage(sender, {
                            text: `🎙️ *Auto Recording ${updatedConfig.AUTO_RECORDING === 'true' ? 'Enabled' : 'Disabled'}*\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`
                        }, { quoted: messageData });
                    }

                    await socket.sendMessage(sender, { react: { text: '✅', key: messageData.key } });
                }
            } catch (error) {
                console.error('Sub-settings handler error:', error);
            }
        };

        socket.ev.on('messages.upsert', buttonHandler);
        setTimeout(() => socket.ev.off('messages.upsert', buttonHandler), 120000);

    } catch (error) {
        console.error('Settings command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== STICKER COMMANDS ====================
case 'sticker':
case 's':
case 'stickergif': {
    try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) {
            return await socket.sendMessage(sender, {
                text: '*Reply to any Image or Video to create a sticker.*'
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, { react: { text: '🔄', key: msg.key } });

        const mimeType = getContentType(quotedMsg);
        const mediaMessage = quotedMsg[mimeType];

        if (mimeType === 'imageMessage' || mimeType === 'stickerMessage') {
            const { Sticker, StickerTypes } = require('wa-sticker-formatter');
            
            const stream = await downloadContentFromMessage(mediaMessage, 'image');
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const mediaBuffer = Buffer.concat(chunks);

            let sticker = new Sticker(mediaBuffer, {
                pack: 'SubZero MD Mini',
                author: 'Mr Frank OFC 🎀',
                type: StickerTypes.FULL,
                categories: ['🤩', '🎉'],
                id: '12345',
                quality: 75,
                background: 'transparent'
            });

            const stickerBuffer = await sticker.toBuffer();
            await socket.sendMessage(sender, { sticker: stickerBuffer }, { quoted: msg });
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } else {
            await socket.sendMessage(sender, {
                text: '*Please reply to an image or use .vsticker for videos.*'
            }, { quoted: msg });
        }
    } catch (error) {
        console.error('Sticker command error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}

case 'take':
case 'rename':
case 'stake': {
    try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) {
            return await socket.sendMessage(sender, {
                text: '*Reply to any sticker to rename it.*'
            }, { quoted: msg });
        }

        const packName = args.join(' ') || 'SubZero MD Mini';

        await socket.sendMessage(sender, { react: { text: '🔄', key: msg.key } });

        const mimeType = getContentType(quotedMsg);
        const mediaMessage = quotedMsg[mimeType];

        if (mimeType === 'imageMessage' || mimeType === 'stickerMessage') {
            const { Sticker, StickerTypes } = require('wa-sticker-formatter');
            
            const stream = await downloadContentFromMessage(mediaMessage, mimeType === 'stickerMessage' ? 'sticker' : 'image');
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const mediaBuffer = Buffer.concat(chunks);

            let sticker = new Sticker(mediaBuffer, {
                pack: packName,
                author: 'Mr Frank OFC 🎀',
                type: StickerTypes.FULL,
                categories: ['🤩', '🎉'],
                id: '12345',
                quality: 75,
                background: 'transparent'
            });

            const stickerBuffer = await sticker.toBuffer();
            await socket.sendMessage(sender, { sticker: stickerBuffer }, { quoted: msg });
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } else {
            await socket.sendMessage(sender, {
                text: '*Please reply to an image or sticker.*'
            }, { quoted: msg });
        }
    } catch (error) {
        console.error('Take command error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}

// ==================== BLOCK/UNBLOCK COMMANDS ====================
case 'block': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "❌ You are not the owner!"
        }, { quoted: msg });

        let target = "";
        if (isGroup) {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg) {
                target = msg.message.extendedTextMessage.contextInfo.participant;
            } else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
            } else {
                return await socket.sendMessage(sender, {
                    text: "❌ In a group, please reply to or mention the user you want to block."
                }, { quoted: msg });
            }
        } else {
            target = sender;
        }

        await socket.updateBlockStatus(target, 'block');
        await socket.sendMessage(sender, {
            text: `🚫 User @${target.split('@')[0]} blocked successfully.`,
            contextInfo: { mentionedJid: [target] }
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🚫', key: msg.key } });
    } catch (error) {
        console.error('Block command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error blocking user: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'unblock': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "❌ You are not the owner!"
        }, { quoted: msg });

        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) {
            return await socket.sendMessage(sender, {
                text: "❌ Please reply to the user you want to unblock."
            }, { quoted: msg });
        }

        const target = msg.message.extendedTextMessage.contextInfo.participant || msg.message.extendedTextMessage.contextInfo.remoteJid;

        await socket.updateBlockStatus(target, 'unblock');
        await socket.sendMessage(sender, {
            text: `✅ User ${target} unblocked successfully.`
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('Unblock command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error unblocking user: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

// ==================== SUDO COMMANDS ====================
case 'setsudo':
case 'addsudo':
case 'addowner': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "_❗This Command Can Only Be Used By My Owner!_"
        }, { quoted: msg });

        let target = null;
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
        } else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (args[0]) {
            target = args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net";
        }

        if (!target) return await socket.sendMessage(sender, {
            text: "❌ Please provide a number or tag/reply a user."
        }, { quoted: msg });

        let owners = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));

        if (owners.includes(target)) {
            return await socket.sendMessage(sender, {
                text: "❌ This user is already a temporary owner."
            }, { quoted: msg });
        }

        owners.push(target);
        const uniqueOwners = [...new Set(owners)];
        fs.writeFileSync("./lib/sudo.json", JSON.stringify(uniqueOwners, null, 2));

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/18il7k.jpg" },
            caption: "✅ Successfully Added User As Temporary Owner\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '😇', key: msg.key } });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "❌ Error: " + err.message }, { quoted: msg });
    }
    break;
}

case 'delsudo':
case 'delowner':
case 'deletesudo': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "_❗This Command Can Only Be Used By My Owner!_"
        }, { quoted: msg });

        let target = null;
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
        } else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (args[0]) {
            target = args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net";
        }

        if (!target) return await socket.sendMessage(sender, {
            text: "❌ Please provide a number or tag/reply a user."
        }, { quoted: msg });

        let owners = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));

        if (!owners.includes(target)) {
            return await socket.sendMessage(sender, {
                text: "❌ User not found in owner list."
            }, { quoted: msg });
        }

        const updated = owners.filter(x => x !== target);
        fs.writeFileSync("./lib/sudo.json", JSON.stringify(updated, null, 2));

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/18il7k.jpg" },
            caption: "✅ Successfully Removed User As Temporary Owner\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🫩', key: msg.key } });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "❌ Error: " + err.message }, { quoted: msg });
    }
    break;
}

case 'listsudo':
case 'listowner': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "_❗This Command Can Only Be Used By My Owner!_"
        }, { quoted: msg });

        let owners = JSON.parse(fs.readFileSync("./lib/sudo.json", "utf-8"));
        owners = [...new Set(owners)];

        if (owners.length === 0) {
            return await socket.sendMessage(sender, {
                text: "❌ No temporary owners found."
            }, { quoted: msg });
        }

        let listMessage = "`🤴 List of Sudo Owners:`\n\n";
        owners.forEach((owner, i) => {
            listMessage += `${i + 1}. ${owner.replace("@s.whatsapp.net", "")}\n`;
        });
        listMessage += "\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ";

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/18il7k.jpg" },
            caption: listMessage
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '📋', key: msg.key } });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "❌ Error: " + err.message }, { quoted: msg });
    }
    break;
}

// ==================== BAN COMMANDS ====================
case 'ban':
case 'blockuser':
case 'addban': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "_❗Only the bot owner can use this command!_"
        }, { quoted: msg });

        let target = null;
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
        } else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (args[0]) {
            target = args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net";
        }

        if (!target) return await socket.sendMessage(sender, {
            text: "❌ Please provide a number or tag/reply a user."
        }, { quoted: msg });

        let banned = JSON.parse(fs.readFileSync("./lib/ban.json", "utf-8"));

        if (banned.includes(target)) {
            return await socket.sendMessage(sender, {
                text: "❌ This user is already banned."
            }, { quoted: msg });
        }

        banned.push(target);
        fs.writeFileSync("./lib/ban.json", JSON.stringify([...new Set(banned)], null, 2));

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/18il7k.jpg" },
            caption: "⛔ User has been banned from using the bot.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '⛔', key: msg.key } });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "❌ Error: " + err.message }, { quoted: msg });
    }
    break;
}

case 'unban':
case 'removeban': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "_❗Only the bot owner can use this command!_"
        }, { quoted: msg });

        let target = null;
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
        } else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (args[0]) {
            target = args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net";
        }

        if (!target) return await socket.sendMessage(sender, {
            text: "❌ Please provide a number or tag/reply a user."
        }, { quoted: msg });

        let banned = JSON.parse(fs.readFileSync("./lib/ban.json", "utf-8"));

        if (!banned.includes(target)) {
            return await socket.sendMessage(sender, {
                text: "❌ This user is not banned."
            }, { quoted: msg });
        }

        const updated = banned.filter(u => u !== target);
        fs.writeFileSync("./lib/ban.json", JSON.stringify(updated, null, 2));

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/18il7k.jpg" },
            caption: "✅ User has been unbanned.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "❌ Error: " + err.message }, { quoted: msg });
    }
    break;
}

case 'listban':
case 'banlist':
case 'bannedusers': {
    try {
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "_❗Only the bot owner can use this command!_"
        }, { quoted: msg });

        let banned = JSON.parse(fs.readFileSync("./lib/ban.json", "utf-8"));
        banned = [...new Set(banned)];

        if (banned.length === 0) {
            return await socket.sendMessage(sender, {
                text: "✅ No banned users found."
            }, { quoted: msg });
        }

        let msg_text = "`⛔ Banned Users:`\n\n";
        banned.forEach((id, i) => {
            msg_text += `${i + 1}. ${id.replace("@s.whatsapp.net", "")}\n`;
        });
        msg_text += "\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ";

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/18il7k.jpg" },
            caption: msg_text
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '📋', key: msg.key } });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "❌ Error: " + err.message }, { quoted: msg });
    }
    break;
}

// ==================== UTILITY COMMANDS ====================

// Channel Info Command
case 'cid':
case 'newsletter':
case 'channelid':
case 'channelinfo': {
    try {
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
        
        if (!q) return await socket.sendMessage(sender, {
            text: "❎ Please provide a WhatsApp Channel link.\n\n*Example:* .cid https://whatsapp.com/channel/123456789"
        }, { quoted: msg });

        const match = q.match(/whatsapp\.com\/channel\/([\w-]+)/);
        if (!match) return await socket.sendMessage(sender, {
            text: "⚠️ *Invalid channel link format.*\n\nMake sure it looks like:\nhttps://whatsapp.com/channel/xxxxxxxxx"
        }, { quoted: msg });

        const inviteId = match[1];
        let metadata;
        
        try {
            metadata = await socket.newsletterMetadata("invite", inviteId);
        } catch (e) {
            return await socket.sendMessage(sender, {
                text: "❌ Failed to fetch channel metadata. Make sure the link is correct."
            }, { quoted: msg });
        }

        if (!metadata || !metadata.id) return await socket.sendMessage(sender, {
            text: "❌ Channel not found or inaccessible."
        }, { quoted: msg });

        const infoText = `\`📡 Channel Info\`\n\n` +
            `🛠️ *ID:* ${metadata.id}\n` +
            `📌 *Name:* ${metadata.name}\n` +
            `👥 *Followers:* ${metadata.subscribers?.toLocaleString() || "N/A"}\n` +
            `📅 *Created on:* ${metadata.creation_time ? new Date(metadata.creation_time * 1000).toLocaleString() : "Unknown"}\n\n` +
            `> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        if (metadata.preview) {
            await socket.sendMessage(sender, {
                image: { url: `https://pps.whatsapp.net${metadata.preview}` },
                caption: infoText
            }, { quoted: msg });
        } else {
            await socket.sendMessage(sender, {
                text: infoText
            }, { quoted: msg });
        }
        
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error("❌ Error in .cid command:", error);
        await socket.sendMessage(sender, {
            text: "⚠️ An unexpected error occurred."
        }, { quoted: msg });
    }
    break;
}

// YouTube Search Command
case 'yts':
case 'ytsearch': {
    try {
        await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } });
        
        if (!q) return await socket.sendMessage(sender, {
            text: '*Please give me words to search*\n\n*Example:* .yts SUBZERO-MD'
        }, { quoted: msg });

        try {
            const yts = require("yt-search");
            const arama = await yts(q);
            
            let mesaj = '🎥 *YOUTUBE SEARCH RESULTS*\n\n';
            arama.all.slice(0, 10).map((video, index) => {
                mesaj += `${index + 1}. *${video.title}*\n🔗 ${video.url}\n\n`;
            });
            mesaj += '> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ';
            
            await socket.sendMessage(sender, { text: mesaj }, { quoted: msg });
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } catch (e) {
            console.error(e);
            return await socket.sendMessage(sender, { text: '*Error occurred while searching!*' }, { quoted: msg });
        }
    } catch (e) {
        console.error(e);
        await socket.sendMessage(sender, { text: '*Error !!*' }, { quoted: msg });
    }
    break;
}

// Remini Image Enhancement Command
case 'remini':
case 'enhance':
case 'hq':
case 'qualityup': {
    try {
        await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
        
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg || (!quotedMsg.imageMessage && !quotedMsg.stickerMessage)) {
            return await socket.sendMessage(sender, {
                text: "Please reply to an image file (JPEG/PNG)"
            }, { quoted: msg });
        }

        const mimeType = quotedMsg.imageMessage ? 'image' : 'sticker';
        const mediaMessage = quotedMsg[mimeType + 'Message'];
        
        await socket.sendMessage(sender, {
            text: "🔄 Enhancing image quality... Please wait."
        }, { quoted: msg });

        const stream = await downloadContentFromMessage(mediaMessage, mimeType === 'sticker' ? 'image' : mimeType);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const mediaBuffer = Buffer.concat(chunks);

        const tempFilePath = path.join(os.tmpdir(), `remini_input_${Date.now()}.jpg`);
        fs.writeFileSync(tempFilePath, mediaBuffer);

        const FormData = require('form-data');
        const form = new FormData();
        form.append('fileToUpload', fs.createReadStream(tempFilePath), 'image.jpg');
        form.append('reqtype', 'fileupload');

        const uploadResponse = await axios.post("https://catbox.moe/user/api.php", form, {
            headers: form.getHeaders()
        });

        const imageUrl = uploadResponse.data;
        fs.unlinkSync(tempFilePath);

        if (!imageUrl) throw new Error("Failed to upload image to Catbox");

        const apiUrl = `https://apis.davidcyriltech.my.id/remini?url=${encodeURIComponent(imageUrl)}`;
        const response = await axios.get(apiUrl, { 
            responseType: 'arraybuffer',
            timeout: 60000
        });

        if (!response.data || response.data.length < 100) {
            throw new Error("API returned invalid image data");
        }

        const outputPath = path.join(os.tmpdir(), `remini_output_${Date.now()}.jpg`);
        fs.writeFileSync(outputPath, response.data);

        await socket.sendMessage(sender, {
            image: fs.readFileSync(outputPath),
            caption: "✅ Image enhanced successfully!\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
        }, { quoted: msg });

        fs.unlinkSync(outputPath);
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('Remini Error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || "Failed to enhance image. The image might be too large or the API is unavailable."}`
        }, { quoted: msg });
    }
    break;
}

// Remove Background Command
case 'removebg':
case 'rmbg':
case 'nobg':
case 'transparentbg': {
    try {
        await socket.sendMessage(sender, { react: { text: '🖼️', key: msg.key } });
        
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg || (!quotedMsg.imageMessage && !quotedMsg.stickerMessage)) {
            return await socket.sendMessage(sender, {
                text: "Please reply to an image file (JPEG/PNG)"
            }, { quoted: msg });
        }

        const mimeType = quotedMsg.imageMessage ? 'image' : 'sticker';
        const mediaMessage = quotedMsg[mimeType + 'Message'];
        
        await socket.sendMessage(sender, {
            text: "🔄 Removing background... Please wait."
        }, { quoted: msg });

        const stream = await downloadContentFromMessage(mediaMessage, mimeType === 'sticker' ? 'image' : mimeType);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const mediaBuffer = Buffer.concat(chunks);

        const tempFilePath = path.join(os.tmpdir(), `removebg_${Date.now()}.jpg`);
        fs.writeFileSync(tempFilePath, mediaBuffer);

        const FormData = require('form-data');
        const form = new FormData();
        form.append('fileToUpload', fs.createReadStream(tempFilePath), 'image.jpg');
        form.append('reqtype', 'fileupload');

        const uploadResponse = await axios.post("https://catbox.moe/user/api.php", form, {
            headers: form.getHeaders()
        });

        const imageUrl = uploadResponse.data;
        fs.unlinkSync(tempFilePath);

        if (!imageUrl) throw new Error("Failed to upload image to Catbox");

        const apiUrl = `https://apis.davidcyriltech.my.id/removebg?url=${encodeURIComponent(imageUrl)}`;
        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

        if (!response.data || response.data.length < 100) {
            throw new Error("API returned invalid image data");
        }

        const outputPath = path.join(os.tmpdir(), `removebg_output_${Date.now()}.png`);
        fs.writeFileSync(outputPath, response.data);

        await socket.sendMessage(sender, {
            image: fs.readFileSync(outputPath),
            caption: "✅ Background removed successfully!\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
        }, { quoted: msg });

        fs.unlinkSync(outputPath);
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('RemoveBG Error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message || "Failed to remove background."}`
        }, { quoted: msg });
    }
    break;
}

// ==================== GROUP MANAGEMENT COMMANDS ====================

case 'kick':
case 'remove': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "⚠️ This command only works in *groups*."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I must be *admin* to remove someone."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "🔐 Only *group admins* or *owner* can use this command."
        }, { quoted: msg });

        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        
        if (!quotedMsg && (!mentionedJid || mentionedJid.length === 0)) {
            return await socket.sendMessage(sender, {
                text: "❓ You did not give me a user to remove!\n\nTag or reply to a user."
            }, { quoted: msg });
        }

        let targetUser = mentionedJid && mentionedJid.length > 0
            ? mentionedJid[0]
            : msg.message.extendedTextMessage.contextInfo.participant;

        if (!targetUser) return await socket.sendMessage(sender, {
            text: "⚠️ Couldn't determine target user."
        }, { quoted: msg });

        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        if (targetUser === botJid) return await socket.sendMessage(sender, {
            text: "🤖 I can't kick myself!"
        }, { quoted: msg });

        await socket.groupParticipantsUpdate(sender, [targetUser], "remove");
        await socket.sendMessage(sender, {
            text: `✅ Successfully removed @${targetUser.split('@')[0]} from group.`,
            contextInfo: { mentionedJid: [targetUser] }
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('Kick command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to remove user: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'add': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "⚠️ This command only works in *groups*."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to add members."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "🔐 Only *group admins* or *owner* can use this command."
        }, { quoted: msg });

        if (!args[0]) return await socket.sendMessage(sender, {
            text: "❌ Please provide a number to add.\n\nExample: .add 1234567890"
        }, { quoted: msg });

        let numberToAdd = args[0].replace(/[^0-9]/g, '');
        const jid = numberToAdd + "@s.whatsapp.net";

        await socket.groupParticipantsUpdate(sender, [jid], "add");
        await socket.sendMessage(sender, {
            text: `✅ Successfully added @${numberToAdd}`,
            contextInfo: { mentionedJid: [jid] }
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '➕', key: msg.key } });
    } catch (error) {
        console.error('Add command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to add member: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'promote':
case 'admin': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "⚠️ This command only works in *groups*."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I must be *admin* to promote someone."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "🔐 Only *group admins* or *owner* can use this command."
        }, { quoted: msg });

        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        
        if (!quotedMsg && (!mentionedJid || mentionedJid.length === 0)) {
            return await socket.sendMessage(sender, {
                text: "❓ You did not give me a user to promote!\n\nTag or reply to a user."
            }, { quoted: msg });
        }

        let targetUser = mentionedJid && mentionedJid.length > 0
            ? mentionedJid[0]
            : msg.message.extendedTextMessage.contextInfo.participant;

        if (!targetUser) return await socket.sendMessage(sender, {
            text: "⚠️ Couldn't determine target user."
        }, { quoted: msg });

        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        if (targetUser === botJid) return await socket.sendMessage(sender, {
            text: "🤖 I can't promote myself!"
        }, { quoted: msg });

        await socket.groupParticipantsUpdate(sender, [targetUser], "promote");
        await socket.sendMessage(sender, {
            text: `✅ Successfully promoted @${targetUser.split('@')[0]} to admin.`,
            contextInfo: { mentionedJid: [targetUser] }
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '⭐', key: msg.key } });
    } catch (error) {
        console.error('Promote command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to promote: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'demote': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "⚠️ This command only works in *groups*."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I must be *admin* to demote someone."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "🔐 Only *group admins* or *owner* can use this command."
        }, { quoted: msg });

        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        
        if (!quotedMsg && (!mentionedJid || mentionedJid.length === 0)) {
            return await socket.sendMessage(sender, {
                text: "❓ You did not give me a user to demote!\n\nTag or reply to a user."
            }, { quoted: msg });
        }

        let targetUser = mentionedJid && mentionedJid.length > 0
            ? mentionedJid[0]
            : msg.message.extendedTextMessage.contextInfo.participant;

        if (!targetUser) return await socket.sendMessage(sender, {
            text: "⚠️ Couldn't determine target user."
        }, { quoted: msg });

        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        if (targetUser === botJid) return await socket.sendMessage(sender, {
            text: "🤖 I can't demote myself!"
        }, { quoted: msg });

        await socket.groupParticipantsUpdate(sender, [targetUser], "demote");
        await socket.sendMessage(sender, {
            text: `✅ Admin @${targetUser.split('@')[0]} successfully demoted to normal member.`,
            contextInfo: { mentionedJid: [targetUser] }
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('Demote command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to demote: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'mute':
case 'lock':
case 'close': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins or owner can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to mute the group."
        }, { quoted: msg });

        await socket.groupSettingUpdate(sender, "announcement");
        await socket.sendMessage(sender, {
            text: "🔒 Group has been closed. Only admins can send messages."
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
    } catch (error) {
        console.error('Mute command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to close group: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'unmute':
case 'unlock':
case 'open': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins or owner can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to unmute the group."
        }, { quoted: msg });

        await socket.groupSettingUpdate(sender, "not_announcement");
        await socket.sendMessage(sender, {
            text: "🔓 Group has been opened. Everyone can send messages."
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
    } catch (error) {
        console.error('Unmute command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to open group: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'kickall': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "⚠️ This command only works in *groups*."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I must be *admin* to kick members."
        }, { quoted: msg });
        
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "🔐 Only the *bot owner* can use this command."
        }, { quoted: msg });

        const groupMetadata = await socket.groupMetadata(sender);
        const participants = groupMetadata.participants;
        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const ownerJid = config.OWNER_NUMBER + '@s.whatsapp.net';

        let toKick = participants
            .filter(p => p.id !== botJid && p.id !== ownerJid && !p.admin)
            .map(p => p.id);

        if (toKick.length === 0) {
            return await socket.sendMessage(sender, {
                text: "👥 No members to kick (excluding owner, bot & admins)."
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: `⚠️ Starting to remove ${toKick.length} members...`
        }, { quoted: msg });

        for (let user of toKick) {
            await socket.groupParticipantsUpdate(sender, [user], "remove");
            await delay(1000);
        }

        await socket.sendMessage(sender, {
            text: `✅ Kicked ${toKick.length} members from the group.`
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    } catch (error) {
        console.error('Kickall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to kick all members: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'hidetag':
case 'htag': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins or owner can use this command."
        }, { quoted: msg });

        const groupMetadata = await socket.groupMetadata(sender);
        const participants = groupMetadata.participants;
        const message = args.join(' ') || 'Hi Everyone! 👋';

        await socket.sendMessage(sender, {
            text: message,
            mentions: participants.map(a => a.id)
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🔊', key: msg.key } });
    } catch (error) {
        console.error('Hidetag command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'tagall': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins or owner can use this command."
        }, { quoted: msg });

        const groupMetadata = await socket.groupMetadata(sender);
        const participants = groupMetadata.participants;
        const message = args.join(' ') || 'Attention Everyone!';

        const tagMessage = `🔔 *Attention Everyone:*\n\n> ${message}\n\n© SUBZERO MD`;
        await socket.sendMessage(sender, {
            text: tagMessage,
            mentions: participants.map(a => a.id)
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });
    } catch (error) {
        console.error('Tagall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'leave':
case 'exit': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only the bot owner can use this command."
        }, { quoted: msg });

        await socket.sendMessage(sender, {
            text: "👋 Goodbye! Leaving group..."
        }, { quoted: msg });
        await delay(1500);
        await socket.groupLeave(sender);
    } catch (error) {
        console.error('Leave command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'invite':
case 'grouplink':
case 'glink': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to get the group link."
        }, { quoted: msg });

        const code = await socket.groupInviteCode(sender);
        await socket.sendMessage(sender, {
            text: `🖇️ *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}`
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🖇️', key: msg.key } });
    } catch (error) {
        console.error('Invite command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'revoke':
case 'resetlink': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to reset the group link."
        }, { quoted: msg });

        await socket.groupRevokeInvite(sender);
        await socket.sendMessage(sender, {
            text: "✅ *Group link has been reset successfully.* ⛔"
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '🔄', key: msg.key } });
    } catch (error) {
        console.error('Revoke command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'ginfo':
case 'groupinfo': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });

        const groupMetadata = await socket.groupMetadata(sender);
        const participants = groupMetadata.participants;
        const admins = participants.filter(p => p.admin);
        const listAdmin = admins.map((v, i) => `${i + 1}. @${v.id.split('@')[0]}`).join('\n');

        let groupPic;
        try {
            groupPic = await socket.profilePictureUrl(sender, 'image');
        } catch {
            groupPic = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
        }

        const infoText = `*━━━━ GROUP INFO ━━━━*

📛 *Name:* ${groupMetadata.subject}
🆔 *JID:* ${groupMetadata.id}
👥 *Members:* ${participants.length}
👑 *Owner:* @${groupMetadata.owner.split('@')[0]}
📝 *Description:* ${groupMetadata.desc?.toString() || 'No description'}

*👮‍♂️ Admins List:*
${listAdmin}

*━━━━━━━━━━━━━━━*

> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

        await socket.sendMessage(sender, {
            image: { url: groupPic },
            caption: infoText,
            mentions: admins.map(a => a.id).concat([groupMetadata.owner])
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '📌', key: msg.key } });
    } catch (error) {
        console.error('Ginfo command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'updategname':
case 'setgroupname': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to update the group name."
        }, { quoted: msg });

        if (!args.join(' ')) return await socket.sendMessage(sender, {
            text: "❌ Please provide a new group name.\n\nExample: .updategname My Cool Group"
        }, { quoted: msg });

        const newName = args.join(' ');
        await socket.groupUpdateSubject(sender, newName);
        await socket.sendMessage(sender, {
            text: `✅ Group name has been updated to: *${newName}*`
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '📝', key: msg.key } });
    } catch (error) {
        console.error('Update group name error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'updategdesc':
case 'setgroupdesc': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to update the group description."
        }, { quoted: msg });

        if (!args.join(' ')) return await socket.sendMessage(sender, {
            text: "❌ Please provide a new group description.\n\nExample: .updategdesc This is a cool group"
        }, { quoted: msg });

        const newDesc = args.join(' ');
        await socket.groupUpdateDescription(sender, newDesc);
        await socket.sendMessage(sender, {
            text: "✅ Group description has been updated."
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });
    } catch (error) {
        console.error('Update group description error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'opentime': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to schedule group opening."
        }, { quoted: msg });

        if (!args[0] || !args[1]) {
            return await socket.sendMessage(sender, {
                text: "❌ Please provide time and unit.\n\nExample: .opentime 10 minute\n\nUnits: second, minute, hour, day"
            }, { quoted: msg });
        }

        let timer;
        const timeValue = parseInt(args[0]);
        const timeUnit = args[1].toLowerCase();

        if (timeUnit === 'second') {
            timer = timeValue * 1000;
        } else if (timeUnit === 'minute') {
            timer = timeValue * 60000;
        } else if (timeUnit === 'hour') {
            timer = timeValue * 3600000;
        } else if (timeUnit === 'day') {
            timer = timeValue * 86400000;
        } else {
            return await socket.sendMessage(sender, {
                text: "*Select:*\nsecond\nminute\nhour\nday\n\n*Example:* .opentime 10 minute"
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: `⏰ Group will automatically open after ${timeValue} ${timeUnit}(s).`
        }, { quoted: msg });

        setTimeout(async () => {
            try {
                await socket.groupSettingUpdate(sender, 'not_announcement');
                await socket.sendMessage(sender, {
                    text: "🔓 *Good News!* Group has been opened. Enjoy! 🎉\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
                }, { quoted: msg });
            } catch (err) {
                console.error('Auto-open error:', err);
            }
        }, timer);

        await socket.sendMessage(sender, { react: { text: '🔑', key: msg.key } });
    } catch (error) {
        console.error('Opentime command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

case 'closetime': {
    try {
        if (!isGroup) return await socket.sendMessage(sender, {
            text: "❌ This command only works in groups."
        }, { quoted: msg });
        
        if (!isAdmins && !isOwner) return await socket.sendMessage(sender, {
            text: "❌ Only group admins can use this command."
        }, { quoted: msg });
        
        if (!isBotAdmin) return await socket.sendMessage(sender, {
            text: "❌ I need to be an admin to schedule group closing."
        }, { quoted: msg });

        if (!args[0] || !args[1]) {
            return await socket.sendMessage(sender, {
                text: "❌ Please provide time and unit.\n\nExample: .closetime 10 minute\n\nUnits: second, minute, hour, day"
            }, { quoted: msg });
        }

        let timer;
        const timeValue = parseInt(args[0]);
        const timeUnit = args[1].toLowerCase();

        if (timeUnit === 'second') {
            timer = timeValue * 1000;
        } else if (timeUnit === 'minute') {
            timer = timeValue * 60000;
        } else if (timeUnit === 'hour') {
            timer = timeValue * 3600000;
        } else if (timeUnit === 'day') {
            timer = timeValue * 86400000;
        } else {
            return await socket.sendMessage(sender, {
                text: "*Select:*\nsecond\nminute\nhour\nday\n\n*Example:* .closetime 10 minute"
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: `⏰ Group will automatically close after ${timeValue} ${timeUnit}(s).`
        }, { quoted: msg });

        setTimeout(async () => {
            try {
                await socket.groupSettingUpdate(sender, 'announcement');
                await socket.sendMessage(sender, {
                    text: "🔐 *Time's Up!* Group has been auto-closed.\n\n> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ"
                }, { quoted: msg });
            } catch (err) {
                console.error('Auto-close error:', err);
            }
        }, timer);

        await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
    } catch (error) {
        console.error('Closetime command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${error.message}`
        }, { quoted: msg });
    }
    break;
}

              case 'deleteme': {
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                }
                await deleteSessionFromStorage(number);
                if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                    try {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                    } catch {}
                    activeSockets.delete(number.replace(/[^0-9]/g, ''));
                    socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                }
                await socket.sendMessage(sender, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(
                        '🗑️ SESSION DELETED',
                        '✅ Your session has been successfully deleted.',
                        '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈'
                    )
                });
                break;
              }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// MongoDB Functions
async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        return session ? session.creds : null;
    } catch (error) {
        console.error('MongoDB restore error:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const session = await Session.findOne({ number });
        return session && session.config ? session.config : { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        await Session.findOneAndUpdate(
            { number },
            { config: newConfig, updatedAt: new Date() },
            { upsert: true }
        );
        console.log(`✅ Config updated for ${number}`);
    } catch (error) {
        console.error('❌ Config update error:', error);
        throw error;
    }
}

async function deleteSessionFromStorage(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        await Session.deleteOne({ number: sanitizedNumber });
        console.log(`✅ Session deleted from MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ MongoDB delete error:', error);
    }
    
    // Clean local files
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);
                
                await deleteSessionFromStorage(number);
                
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}`, error);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const sessionData = JSON.parse(fileContent);
            
            try {
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    { 
                        creds: sessionData,
                        lastActive: new Date(),
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );
                console.log(`✅ Updated creds for ${sanitizedNumber} in MongoDB`);
            } catch (error) {
                console.error('❌ MongoDB save error:', error);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message || err);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message || error);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    // Send professional connection message
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                           '🎉 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐓𝐎 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐈𝐍𝐈 🎉',
                           `╭────────────────────╮
│ ✅ *CONNECTION SUCCESSFUL!*
│
│ 📱 *Number:* ${sanitizedNumber}
│ 🤖 *Bot Status:* Active & Ready
│ 📡 *Channel:* Subscribed ✓
│ 🔮 *Version:* v1.0.0
│
│ 📚 Type ${config.PREFIX}menu to explore
│ ⚙️ Type ${config.PREFIX}settings to configure
│
╰────────────────────╯
> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`,
                           `📨 Support: ${config.CHANNEL_LINK}`
                        )
                    });

                    // Load user config for settings display
                    const userConfig = await loadUserConfig(sanitizedNumber);

                    // Send settings guide as follow-up message
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                           '⚙️ 𝐁𝐎𝐓 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒 & 𝐂𝐎𝐍𝐅𝐈𝐆𝐔𝐑𝐀𝐓𝐈𝐎𝐍',
                           `╭─「 CURRENT SETTINGS 」
│ 
│ 📌 *Prefix:* ${userConfig.PREFIX || config.PREFIX}
│ 🔐 *Mode:* ${(userConfig.MODE || config.MODE).toUpperCase()}
│ 👁️ *Auto View Status:* ${(userConfig.AUTO_VIEW_STATUS || config.AUTO_VIEW_STATUS) === 'true' ? '✅ ON' : '❌ OFF'}
│ ❤️ *Auto React Status:* ${(userConfig.AUTO_LIKE_STATUS || config.AUTO_LIKE_STATUS) === 'true' ? '✅ ON' : '❌ OFF'}
│ 📵 *Anti-Call:* ${(userConfig.ANTICALL || config.ANTICALL) === 'true' ? '✅ ON' : '❌ OFF'}
│ 🎙️ *Auto Recording:* ${(userConfig.AUTO_RECORDING || config.AUTO_RECORDING) === 'true' ? '✅ ON' : '❌ OFF'}
│
╰──────────────────────

╭─「 QUICK SETUP GUIDE 」
│
│ *Change Settings Instantly:*
│ 
│ 🔐 ${config.PREFIX}mode public
│ 🔐 ${config.PREFIX}mode private
│ 
│ 📌 ${config.PREFIX}setprefix !
│ 📌 ${config.PREFIX}setprefix #
│ 
│ 🎙️ ${config.PREFIX}setautorecording on
│ 🎙️ ${config.PREFIX}setautorecording off
│ 
│ 👁️ ${config.PREFIX}autoviewstatus on
│ 👁️ ${config.PREFIX}autoviewstatus off
│ 
│ ❤️ ${config.PREFIX}autoreactstatus on
│ ❤️ ${config.PREFIX}autoreactstatus off
│ 
│ 📵 ${config.PREFIX}anticall on
│ 📵 ${config.PREFIX}anticall off
│
│ ⚙️ ${config.PREFIX}settings - Interactive Menu
│
╰──────────────────────

💡 *TIP:* Changes take effect immediately!
🔄 *Note:* All settings are saved automatically`,
                           '> © 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            try {
                res.status(503).send({ error: 'Service Unavailable' });
            } catch {}
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈 is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const sessions = await Session.find({});
        
        if (sessions.length === 0) {
            return res.status(404).send({ error: 'No session files found in MongoDB' });
        }

        const results = [];
        for (const session of sessions) {
            if (activeSockets.has(session.number)) {
                results.push({ number: session.number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(session.number, mockRes);
                results.push({ number: session.number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${session.number}:`, error);
                results.push({ number: session.number, status: 'failed', error: error.message || error });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    '> 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    try { fs.emptyDirSync(SESSION_BASE_PATH); } catch {}
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
});

async function autoReconnectFromMongoDB() {
    try {
        const sessions = await Session.find({});
        
        for (const session of sessions) {
            if (!activeSockets.has(session.number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(session.number, mockRes);
                console.log(`🔁 Reconnected from MongoDB: ${session.number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ MongoDB auto-reconnect error:', error);
    }
}

autoReconnectFromMongoDB();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/mrfr8nk/database/refs/heads/main/newsletter_list.json'); // Do not edit this part
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message || err);
        return [];
    }
}
