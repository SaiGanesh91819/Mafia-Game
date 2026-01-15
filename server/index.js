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

const broadcastState = () => io.emit('state_update', { players, gameState, gameConfig });

io.on('connection', (socket) => {
    socket.emit('state_update', { players, gameState, gameConfig });

    socket.on('create_game_setup', ({ name, hostName, roles }) => {
        players = [{ id: socket.id, name: hostName, isHost: true, isAlive: true, role: 'HOST', connected: true, roleViewed: true }];
        gameState = { phase: 'LOBBY', round: 0, nightActions: {}, dayVotes: {} };
        gameConfig = { isCreated: true, gameName: name, roles: roles };
        broadcastState();
    });

    socket.on('join_game', ({ name }) => {
        if (!gameConfig.isCreated || gameState.phase !== 'LOBBY') return socket.emit('error_message', "Cannot join now.");
        const totalRoles = (gameConfig.roles.terrorist || 0) + (gameConfig.roles.police || 0) + (gameConfig.roles.doctor || 0) + (gameConfig.roles.villager || 0);
        if (players.length - 1 >= totalRoles) return socket.emit('error_message', "Lobby is Full!");

        if (!players.find(p => p.id === socket.id)) {
            players.push({ id: socket.id, name, isHost: false, isAlive: true, role: null, connected: true, roleViewed: false });
        }
        broadcastState();
    });

    socket.on('start_game', () => {
        const nonHost = players.filter(p => !p.isHost);
        const { terrorist, police, doctor, villager } = gameConfig.roles;
        
        let available = [];
        for(let i=0; i<terrorist; i++) available.push('TERRORIST');
        for(let i=0; i<police; i++) available.push('POLICE');
        for(let i=0; i<doctor; i++) available.push('DOCTOR');
        for(let i=0; i<villager; i++) available.push('VILLAGER');
        
        while(available.length < nonHost.length) available.push('VILLAGER');
        available.sort(() => Math.random() - 0.5);

        let idx = 0;
        players = players.map(p => {
            if (p.isHost) return { ...p, role: 'HOST', isAlive: true, roleViewed: true };
            if (idx >= available.length) return { ...p, role: 'VILLAGER', roleDetails: getRoleDetails('VILLAGER'), isAlive: true, roleViewed: false };
            return { ...p, role: available[idx++], roleDetails: getRoleDetails(available[idx-1]), isAlive: true, roleViewed: false };
        });
        
        gameState.phase = 'ROLE_REVEAL';
        broadcastState();
    });

    socket.on('ack_role', () => {
        players = players.map(p => p.id === socket.id ? { ...p, roleViewed: true } : p);
        broadcastState();
    });

    socket.on('start_night', () => {
        gameState.round++;
        gameState.nightActions = { terroristSelection: null, policeSelection: null, doctorSelection: null };
        gameState.victim = null;
        gameState.phase = 'NIGHT_TERRORIST';
        broadcastState();
    });

    socket.on('terrorist_select', (id) => { gameState.nightActions.terroristSelection = id; broadcastState(); });
    socket.on('host_confirm_terrorist', () => { gameState.phase = 'NIGHT_POLICE'; broadcastState(); });

    socket.on('police_select', (id) => { 
        gameState.nightActions.policeSelection = id; 
        broadcastState();
        const target = players.find(p => p.id === id);
        io.to(socket.id).emit('police_result', { isTerrorist: target?.role === 'TERRORIST' });
    });
    socket.on('host_confirm_police', () => { gameState.phase = 'NIGHT_DOCTOR'; broadcastState(); });

    socket.on('doctor_select', (id) => { gameState.nightActions.doctorSelection = id; broadcastState(); });
    socket.on('host_confirm_doctor', () => { 
        const { terroristSelection, doctorSelection } = gameState.nightActions;
        gameState.victim = (terroristSelection && terroristSelection !== doctorSelection) ? terroristSelection : null;
        if (gameState.victim) players = players.map(p => p.id === gameState.victim ? { ...p, isAlive: false } : p);
        gameState.phase = 'DAY_ANNOUNCE';
        broadcastState();
    });

    socket.on('start_discussion', () => { gameState.phase = 'DAY_DISCUSSION'; broadcastState(); });
    socket.on('start_voting', () => { gameState.phase = 'DAY_VOTE'; gameState.dayVotes = {}; broadcastState(); });
    socket.on('cast_vote', ({ voterId, targetId }) => { gameState.dayVotes[voterId] = targetId; broadcastState(); });
    
    socket.on('finalize_vote', () => {
        const counts = {};
        Object.values(gameState.dayVotes).forEach(t => counts[t] = (counts[t]||0)+1);
        let max=0, cands=[];
        for (const [t,c] of Object.entries(counts)) { if(c>max){max=c;cands=[t]}else if(c===max)cands.push(t) }
        
        if (cands.length === 1) {
            gameState.eliminated = cands[0];
            players = players.map(p => p.id === cands[0] ? { ...p, isAlive: false } : p);
            const winner = checkWin();
            gameState.phase = winner ? 'GAME_OVER' : 'DAY_ELIMINATION';
            gameState.winner = winner;
        } else {
            gameState.message = "Tie! Discuss again.";
            gameState.phase = 'DAY_DISCUSSION';
        }
        broadcastState();
    });
    
    socket.on('next_round', () => {
        gameState.phase = 'NIGHT_TERRORIST';
        gameState.round++;
        gameState.nightActions = {};
        broadcastState();
    });
    socket.on('close_game', () => { gameConfig.isCreated = false; gameState.phase = 'SETUP'; broadcastState(); }); // Fixed Reset

    socket.on('disconnect', () => {
        if (gameState.phase === 'SETUP' || gameState.phase === 'LOBBY') players = players.filter(p => p.id !== socket.id);
        else players = players.map(p => p.id === socket.id ? { ...p, connected: false } : p);
        broadcastState();
    });
});

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
