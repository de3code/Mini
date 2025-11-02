require('dotenv').config();

const parseList = (envVar, fallback) => {
  if (!envVar) return fallback;
  try {
    return JSON.parse(envVar);
  } catch {
    return envVar.split(',').map(s => s.trim()).filter(Boolean);
  }
};

module.exports = {
  // MongoDB configuration for storing sessions
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://darexmucheri:cMd7EoTwGglJGXwR@cluster0.uwf6z.mongodb.net/mini?retryWrites=true&w=majority&appName=Cluster0',
  
  // Bot behavior
  AUTO_VIEW_STATUS: process.env.AUTO_VIEW_STATUS || 'true',
  AUTO_LIKE_STATUS: process.env.AUTO_LIKE_STATUS || 'true',
  AUTO_RECORDING: process.env.AUTO_RECORDING || 'false',
  AUTO_LIKE_EMOJI: parseList(process.env.AUTO_LIKE_EMOJI, ['💋', '🍬', '🫆', '💗', '🎈', '🎉', '🥳', '❤️', '🧫', '🐭']),
  PREFIX: process.env.PREFIX || '.',
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),

  // Paths
  ADMIN_LIST_PATH: process.env.ADMIN_LIST_PATH || './admin.json',
  SESSION_BASE_PATH: process.env.SESSION_BASE_PATH || './session',
  NUMBER_LIST_PATH: process.env.NUMBER_LIST_PATH || './numbers.json',

  // Images / UI
  RCD_IMAGE_PATH: process.env.RCD_IMAGE_PATH || 'https://dabby.vercel.app/mini_menu1.png',
  CAPTION: process.env.CAPTION || '𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈 🎀',

  // Newsletter / channels
  NEWSLETTER_JID: (process.env.NEWSLETTER_JID || '120363402507750390@newsletter').trim(),
  CHANNEL_LINK: process.env.CHANNEL_LINK || 'https://whatsapp.com/channel/0029VagQEmB002T7MWo3Sj1D',

  // OTP & owner
  OTP_EXPIRY: parseInt(process.env.OTP_EXPIRY || '300000', 10), // ms
  OWNER_NUMBER: process.env.OWNER_NUMBER || '263719647303',

  // Misc
  GROUP_INVITE_LINK: process.env.GROUP_INVITE_LINK || 'https://chat.whatsapp.com/BeJsVhuJFSj5P3aCbFaf4w',
  PM2_NAME: process.env.PM2_NAME || 'SUBZERO-MD'
};
