const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
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
    let userId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch(data.type) {
                case 'join':
                    currentRoom = data.room;
                    userId = data.userId;
                    
                    if (!rooms.has(currentRoom)) {
                        rooms.set(currentRoom, new Map());
                    }
                    
                    const room = rooms.get(currentRoom);
                    
                    // Send list of existing users to the new user
                    const existingUsers = Array.from(room.keys());
                    ws.send(JSON.stringify({
                        type: 'room-users',
                        users: existingUsers
                    }));
                    
                    // Notify others about the new user
                    room.forEach((client, existingUserId) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'user-joined',
                                userId: userId
                            }));
                        }
                    });
                    
                    // Add the new user to the room
                    room.set(userId, ws);
                    
                    console.log(`${userId} joined room: ${currentRoom} (${room.size} users)`);
                    break;

                case 'leave':
                    handleUserLeave(currentRoom, userId);
                    break;

                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    // Forward message to specific target user
                    if (currentRoom && rooms.has(currentRoom)) {
                        const room = rooms.get(currentRoom);
                        const targetClient = room.get(data.target);
                        
                        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                            // Add sender info
                            data.sender = userId;
                            targetClient.send(JSON.stringify(data));
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        handleUserLeave(currentRoom, userId);
    });

    function handleUserLeave(room, user) {
        if (room && user && rooms.has(room)) {
            const roomMap = rooms.get(room);
            roomMap.delete(user);
            
            // Notify others about the user leaving
            roomMap.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'user-left',
                        userId: user
                    }));
                }
            });
            
            console.log(`${user} left room: ${room} (${roomMap.size} users)`);
            
            // Clean up empty rooms
            if (roomMap.size === 0) {
                rooms.delete(room);
            }
        }
    }
});

const PORT = 8080;

server.listen(PORT, () => {
    console.log(`🎤 Voice Chat Server Running on port ${PORT}`);
    console.log(`Access at: http://YOUR_VPS_IP:${PORT}/vc.html`);
});