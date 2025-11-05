# SUBZERO MD Mini WhatsApp Bot

## Project Overview
This is a WhatsApp bot application built with Node.js that provides pairing code generation and bot management capabilities. The bot supports multiple WhatsApp numbers and includes features like status viewing, auto-reactions, and command handling.

## Technology Stack
- **Backend Framework**: Express.js (Node.js)
- **WhatsApp Integration**: @whiskeysockets/baileys
- **Database**: MongoDB (using Mongoose)
- **Port**: 5000 (Frontend web interface)
- **Language**: JavaScript (Node.js 20)

## Project Structure
- `index.js` - Main Express server setup (runs on port 5000)
- `pair.js` - WhatsApp pairing logic and bot management
- `config.js` - Configuration management with environment variable support
- `msg.js` - Message handling utilities
- `Id.js` - ID generation utilities
- `main.html` - Frontend pairing interface
- `admin.json` - Admin phone numbers list
- `session/` - WhatsApp session storage directory

## Key Features
1. **WhatsApp Pairing**: Web interface to generate pairing codes for WhatsApp
2. **Multi-Session Support**: Connect multiple WhatsApp numbers
3. **Auto Status View & React**: Automatically view and react to WhatsApp statuses
4. **Newsletter Integration**: React to newsletter messages
5. **Command System**: Prefix-based command handling (default: `.`)
6. **MongoDB Sessions**: Persistent session storage in cloud database

## Configuration
All configuration is managed through `config.js` which reads from environment variables with sensible defaults:
- `PORT` - Server port (default: 5000)
- `MONGODB_URI` - MongoDB connection string
- `PREFIX` - Command prefix (default: `.`)
- `OWNER_NUMBER` - Bot owner's phone number
- `AUTO_VIEW_STATUS` - Auto view statuses (default: true)
- `AUTO_LIKE_STATUS` - Auto react to statuses (default: true)

## Running the Application
The application runs automatically via the configured workflow:
```bash
npm start
```

The Express server will start on port 5000 and connect to MongoDB.

## Deployment Configuration
- **Deployment Type**: VM (Always-on instance)
- **Reason**: WhatsApp bot needs to maintain persistent connections and state
- **Run Command**: `npm start`

## Recent Changes (November 5, 2025)
- Configured for Replit environment
- Updated server port from 7860 to 5000
- Added .gitignore for Node.js project
- Configured workflow for Express server
- Set up deployment configuration for VM deployment
- Verified frontend and backend functionality

## MongoDB Connection
The app uses MongoDB Atlas for session storage. The connection string is configured in `config.js` with a fallback to the default cloud database.

## User Workflow
1. User visits the web interface at the deployed URL
2. Enters their WhatsApp number with country code
3. Clicks "Get Code" to generate a pairing code
4. Uses the code in WhatsApp to connect their number to the bot
5. Bot joins the configured group and sends confirmation to admins

## Bot Commands
Commands use the prefix defined in config (default `.`):
- `.ping` / `.speed` / `.pong` - Check bot latency and status
- Additional commands defined in `pair.js`

## Admin Configuration
Admin phone numbers are stored in `admin.json` (JSON array format). Admins receive connection notifications when new numbers pair with the bot.

## Notes
- The application uses MongoDB for session persistence
- WhatsApp sessions are stored both locally (./session) and in MongoDB
- The bot automatically handles message revocation detection
- Supports view-once message handling for admins
