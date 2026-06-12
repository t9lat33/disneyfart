const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = http.createServer((req, res) => {
    // Serve vc.html when requested
    if (req.url === '/vc.html' || req.url === '/') {
        fs.readFile(path.join(__dirname, 'vc.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                return res.end('Error loading vc.html');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

const wss = new WebSocket.Server({ server });

// Store rooms and their participants
const rooms = new Map();

wss.on('connection', (ws) => {
    let currentRoom = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch(data.type) {
            case 'join':
                currentRoom = data.room;
                if (!rooms.has(currentRoom)) {
                    rooms.set(currentRoom, new Set());
                }
                rooms.get(currentRoom).add(ws);
                console.log(`Client joined room: ${currentRoom}`);
                break;

            case 'offer':
            case 'answer':
            case 'ice':
                // Forward message to all other peers in the room
                if (currentRoom && rooms.has(currentRoom)) {
                    rooms.get(currentRoom).forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    });
                }
                break;
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms.has(currentRoom)) {
            rooms.get(currentRoom).delete(ws);
            if (rooms.get(currentRoom).size === 0) {
                rooms.delete(currentRoom);
            }
            console.log(`Client left room: ${currentRoom}`);
        }
    });
});

const PORT = 8080;

// Function to get local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

server.listen(PORT, () => {
    const ip = getLocalIP();
    console.log(`🎤 Voice Chat Server Running:`);
    console.log(`   Local:   http://localhost:${PORT}/vc.html`);
    console.log(`   Network: http://${ip}:${PORT}/vc.html`);
    console.log(`   Replace with your VPS IP if accessing externally`);
});