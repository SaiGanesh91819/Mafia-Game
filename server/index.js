const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const localIpUrl = require('local-ip-url');
const path = require('path');

const app = express();
app.use(cors());

// Serve Static Files from React App
app.use(express.static(path.join(__dirname, '../client/dist')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let players = []; 
let gameConfig = { isCreated: false, gameName: "", roles: { terrorist: 2, doctor: 1, police: 1, villager: 0 } };
let gameState = { phase: 'SETUP', round: 0, nightActions: {}, dayVotes: {}, victim: null, eliminated: null, winner: null, message: "" };

const getRoleDetails = (role) => {
    switch(role) {
        case 'TERRORIST': return { team: 'BAD', name: 'Terrorist', ability: 'Kill', description: 'Kill one villager every night.' };
        case 'POLICE': return { team: 'GOOD', name: 'Police', ability: 'Suspect', description: 'Investigate one person every night.' };
        case 'DOCTOR': return { team: 'GOOD', name: 'Doctor', ability: 'Save', description: 'Protect one person every night.' };
        default: return { team: 'GOOD', name: 'Villager', ability: 'Vote', description: 'Find the terrorists during the day.' };
    }
};

// const broadcastState = () => io.emit('state_update', { players, gameState, gameConfig });

const games = new Map(); // roomId -> { config, state, players[], hostId, timer }

const generateRoomId = () => Math.random().toString(36).substr(2, 6).toUpperCase();

// Helper: Broadcast state to a specific room
const broadcastRoom = (roomId, io) => {
    const game = games.get(roomId);
    if (!game) return;
    io.to(roomId).emit('state_update', { 
        players: game.players, 
        gameState: game.state, 
        gameConfig: game.config,
        roomId 
    });
};

const broadcastRoomsList = (io) => {
    const list = [];
    games.forEach((g, id) => {
        if(g.state.phase === 'LOBBY') list.push({ id, name: g.config.gameName, count: g.players.length, host: g.players.find(p=>p.isHost)?.name });
    });
    io.emit('rooms_list', list);
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Send list of rooms on connect
    broadcastRoomsList(io);

    socket.on('create_game_setup', ({ name, hostName, roles, playerId }) => {
        const roomId = generateRoomId();
        const initialPlayers = [{ 
            id: socket.id, 
            playerId,
            name: hostName, 
            isHost: true, 
            isAlive: true, 
            role: 'HOST', 
            connected: true,
            roleViewed: true 
        }];
        
        games.set(roomId, {
            config: { gameName: name, roles, isCreated: true },
            state: { phase: 'LOBBY', message: 'Waiting for players...', dayVotes: {}, nightActions: {}, victim: null, winner: null },
            players: initialPlayers,
            hostId: socket.id
        });
        
        socket.join(roomId);
        // Tag socket with roomId for easy lookup on disconnect
        socket.data.roomId = roomId;
        socket.data.playerId = playerId;
        
        broadcastRoom(roomId, io);
        broadcastRoomsList(io);
    });

    socket.on('join_game', ({ roomId, name, playerId }) => {
        const game = games.get(roomId);
        if (!game) return socket.emit('error_message', "Game not found.");
        
        // 1. Rejoin Check
        const existing = game.players.find(p => p.playerId === playerId);
        if (existing) {
             existing.id = socket.id;
             existing.connected = true;
             existing.name = name; // Update name
             socket.join(roomId);
             socket.data.roomId = roomId;
             socket.data.playerId = playerId;
             broadcastRoom(roomId, io);
             return;
        }

        // 2. New Player Check
        if (game.state.phase !== 'LOBBY') return socket.emit('error_message', "Game in Progress. Cannot join now.");

        const totalRoles = (game.config.roles.terrorist || 0) + (game.config.roles.police || 0) + (game.config.roles.doctor || 0) + (game.config.roles.villager || 0);
        if (game.players.length - 1 >= totalRoles) return socket.emit('error_message', "Lobby is Full!");

        game.players.push({ id: socket.id, playerId, name, isHost: false, isAlive: true, role: null, connected: true, roleViewed: false });
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.playerId = playerId;
        
        broadcastRoom(roomId, io);
        broadcastRoomsList(io);
    });
    
    socket.on('reconnect_session', ({ playerId }) => {
        // Find which room this player belongs to
        let foundRoomId = null;
        games.forEach((g, rId) => {
            if (g.players.find(p => p.playerId === playerId)) foundRoomId = rId;
        });

        if (foundRoomId) {
            const game = games.get(foundRoomId);
            const p = game.players.find(p => p.playerId === playerId);
            if (p) {
                p.id = socket.id;
                p.connected = true;
                socket.join(foundRoomId);
                socket.data.roomId = foundRoomId;
                socket.data.playerId = playerId;
                broadcastRoom(foundRoomId, io);
            }
        } else {
            // Not in any active game, just send list
            broadcastRoomsList(io);
        }
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        
        const game = games.get(roomId);
        if (!game) return;

        const p = game.players.find(p => p.id === socket.id);
        if (p) {
            p.connected = false;
            
            // HOST DISCONNECT LOGIC
            if (p.isHost && game.state.phase === 'LOBBY') {
                // ABORT GAME
                io.to(roomId).emit('error_message', "Host disconnected. Game aborted.");
                io.to(roomId).emit('game_closed'); // Force clients to return to landing
                io.in(roomId).socketsLeave(roomId); // Kick everyone out of room
                games.delete(roomId);
                broadcastRoomsList(io);
                return;
            }
            
            // Normal Player Disconnect
            if (game.state.phase === 'LOBBY') {
                game.players = game.players.filter(pl => pl.id !== socket.id);
                broadcastRoom(roomId, io);
                broadcastRoomsList(io);
            } else {
                // In-game: Just mark disconnected (Persistence)
                broadcastRoom(roomId, io);
            }
        }
    });
    
    // --- GAME ACTIONS (Bound to Room) ---
    const withGame = (cb) => {
        const rId = socket.data.roomId;
        if(rId && games.has(rId)) cb(games.get(rId), rId);
    };

    socket.on('start_game', () => withGame((game, roomId) => {
        // ... (Existing Start Logic, updated to use 'game' obj) ...
        const required = (game.config.roles.terrorist||0) + (game.config.roles.police||0) + (game.config.roles.doctor||0) + (game.config.roles.villager||0);
        if (game.players.length - 1 < required) return socket.emit('error_message', `Need ${required} players!`);
        
        // Assign Roles
        let deck = [];
        ['terrorist','police','doctor','villager'].forEach(r => {
             for(let i=0; i<(game.config.roles[r]||0); i++) deck.push(r.toUpperCase());
        });
        // Shuffle
        for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
        
        let deckIdx = 0;
        game.players.forEach(p => {
            if (!p.isHost) { p.role = deck[deckIdx++] || 'VILLAGER'; p.isAlive = true; p.roleViewed = false; }
        });
        
        game.state.phase = 'ROLE_REVEAL';
        broadcastRoom(roomId, io);
        broadcastRoomsList(io); // Update lobby count/status
    }));
    
    socket.on('ack_role', () => withGame((game, roomId) => {
        const p = game.players.find(p => p.id === socket.id);
        if(p) { p.roleViewed = true; broadcastRoom(roomId, io); }
    }));

    socket.on('start_night', () => withGame((game, roomId) => {
        game.state.phase = 'NIGHT_TERRORIST';
        game.state.nightActions = {};
        broadcastRoom(roomId, io);
    }));
    
    socket.on('terrorist_select', (id) => withGame((game, roomId) => {
        if (!game.state.nightActions) game.state.nightActions = {};
        game.state.nightActions.terroristSelection = id;
        broadcastRoom(roomId, io);
    }));

    socket.on('host_confirm_terrorist', () => withGame((game, roomId) => {
        game.state.phase = 'NIGHT_POLICE';
        broadcastRoom(roomId, io);
    }));
    
    socket.on('police_select', (id) => withGame((game, roomId) => {
        if (!game.state.nightActions) game.state.nightActions = {};
        game.state.nightActions.policeSelection = id;
        broadcastRoom(roomId, io);
        const target = game.players.find(p => p.id === id);
        socket.emit('police_result', { isTerrorist: target?.role === 'TERRORIST' });
    }));
    
    socket.on('host_confirm_police', () => withGame((game, roomId) => {
        game.state.phase = 'NIGHT_DOCTOR';
        broadcastRoom(roomId, io);
    }));

     socket.on('doctor_select', (id) => withGame((game, roomId) => {
        if (!game.state.nightActions) game.state.nightActions = {};
        game.state.nightActions.doctorSelection = id;
        broadcastRoom(roomId, io);
    }));

    socket.on('host_confirm_doctor', () => withGame((game, roomId) => {
        // Resolve Night
        const victimId = game.state.nightActions.terroristSelection;
        const savedId = game.state.nightActions.doctorSelection;
        
        game.state.victim = (victimId && victimId !== savedId) ? victimId : null;
        if (game.state.victim) {
            const v = game.players.find(p => p.id === game.state.victim);
            if(v) v.isAlive = false;
        }
        
        game.state.phase = 'DAY_ANNOUNCE';
        checkWinCondition(game, roomId, io);
        if(game.state.phase !== 'GAME_OVER') broadcastRoom(roomId, io);
    }));

    socket.on('start_discussion', () => withGame((game, roomId) => {
        game.state.phase = 'DAY_DISCUSSION';
        broadcastRoom(roomId, io);
    }));

    socket.on('start_voting', () => withGame((game, roomId) => {
        game.state.phase = 'DAY_VOTE';
        game.state.dayVotes = {};
        broadcastRoom(roomId, io);
    }));

    socket.on('cast_vote', ({ voterId, targetId }) => withGame((game, roomId) => {
        if (!game.state.dayVotes) game.state.dayVotes = {};
        game.state.dayVotes[voterId] = targetId;
        broadcastRoom(roomId, io);
    }));

    socket.on('finalize_vote', () => withGame((game, roomId) => {
         // Tally
         const counts = {};
         Object.values(game.state.dayVotes).forEach(id => counts[id] = (counts[id]||0)+1);
         let max = 0, eliminated = null;
         Object.entries(counts).forEach(([id, c]) => { if(c > max){ max=c; eliminated=id; } else if(c===max) eliminated=null; });
         
         if (eliminated) {
             const p = game.players.find(p => p.id === eliminated);
             if(p) p.isAlive = false;
             game.state.eliminated = eliminated;
             game.state.phase = 'DAY_ELIMINATION';
         } else {
             game.state.eliminated = null;
             game.state.message = "Tie vote. No one eliminated.";
             game.state.phase = 'DAY_DISCUSSION'; // Loop back if tie
         }
         
         checkWinCondition(game, roomId, io);
         if(game.state.phase !== 'GAME_OVER') broadcastRoom(roomId, io);
    }));
    
    socket.on('next_round', () => withGame((game, roomId) => {
        game.state.phase = 'NIGHT_TERRORIST';
        game.state.nightActions = {};
        broadcastRoom(roomId, io);
    }));

    socket.on('close_game', () => withGame((game, roomId) => {
        io.to(roomId).emit('game_closed');
        io.in(roomId).socketsLeave(roomId);
        games.delete(roomId);
        broadcastRoomsList(io);
    }));

});

function checkWinCondition(game, roomId, io) {
    const terrorists = game.players.filter(p => p.role === 'TERRORIST' && p.isAlive).length;
    const innocent = game.players.filter(p => p.role !== 'TERRORIST' && p.role !== 'HOST' && p.isAlive).length;
    
    if (terrorists === 0) {
        game.state.phase = 'GAME_OVER';
        game.state.winner = 'VILLAGERS';
        broadcastRoom(roomId, io);
    } else if (terrorists >= innocent) {
        game.state.phase = 'GAME_OVER';
        game.state.winner = 'TERRORISTS';
        broadcastRoom(roomId, io);
    }
}

// Handle React Routing (any unknown route returns index.html)
app.use((req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/dist', 'index.html'));
});

function checkWin() {
    const t = players.filter(p => p.role === 'TERRORIST' && p.isAlive).length;
    const v = players.filter(p => p.role !== 'TERRORIST' && p.role !== 'HOST' && p.isAlive).length;
    if (t === 0) return 'VILLAGERS';
    if (t >= v) return 'TERRORISTS';
    return null;
}

server.listen(3000, '0.0.0.0', () => console.log(`MAFIA Server Running on ${localIpUrl('public')}:3000`));
