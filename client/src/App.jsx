/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from 'react'
import io from 'socket.io-client'

const socket = io(`http://${window.location.hostname}:3000`);

// --- UI COMPONENTS ---
const JumbleText = ({ text }) => {
    const [display, setDisplay] = useState('ENCRYPTED');
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    useEffect(() => {
        let iter = 0;
        const interval = setInterval(() => {
            setDisplay(text.split('').map((c, i) => {
                if (i < iter) return text[i];
                return chars[Math.floor(Math.random() * chars.length)];
            }).join(''));
            if (iter >= text.length) clearInterval(interval);
            iter += 1/2; 
        }, 30);
        return () => clearInterval(interval);
    }, [text]);
    return <h2 className="jumble-text" style={{letterSpacing: '4px', overflowWrap: 'break-word'}}>{display}</h2>;
};

const RoleFlipCard = ({ role, details, onDismiss }) => {
    const [flipped, setFlipped] = useState(false);
    return (
        <div className={`role-reveal-container ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped(true)}>
            <div className="role-card-inner">
                <div className="role-front">
                    <div className="secret-stamp">TOP SECRET</div>
                    <p>TAP TO DECRYPT</p>
                </div>
                <div className="role-back">
                    <div className="secret-stamp" style={{transform: 'rotate(0)', border:'none', fontSize:'1.2rem', marginBottom:10}}>IDENTITY CONFIRMED</div>
                    <JumbleText text={role} />
                    <p style={{fontSize:'0.9rem'}}>{details.description}</p>
                    <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); onDismiss(); }}>ACKNOWLEDGE</button>
                </div>
            </div>
        </div>
    );
};

const SkyParams = ({ isNight }) => (
    <div className={`sky-elements ${isNight ? 'night' : 'day'}`}>
        <div className="celestial-body"></div>
    </div>
);

const SelectionGrid = ({ players, onSelect, currentSelection, tempSelection, filter = () => true }) => (
  <div className="player-list">
      {players.filter(p => !p.isHost && p.isAlive && filter(p)).map(p => (
          <div key={p.id} 
               className={`player-item ${currentSelection === p.id ? 'confirmed' : ''} ${tempSelection === p.id ? 'selected' : ''}`} 
               onClick={() => onSelect(p.id)}>
               {p.name}
          </div>
      ))}
  </div>
);

// --- MAIN APP ---
function App() {
  const [me, setMe] = useState({ id: '', name: '', role: null, roleViewed: false });
  const [view, setView] = useState('LANDING'); 
  const [inputName, setInputName] = useState('');
  const [gameName, setGameName] = useState('Mafia LAN');
  const [setupConfig, setSetupConfig] = useState({ terrorist: 1, police: 1, doctor: 1, villager: 1 });
  
  const [players, setPlayers] = useState([]);
  const [gameState, setGameState] = useState({ phase: 'CONNECTING' }); 
  const [gameConfig, setGameConfig] = useState({});
  const [policeResult, setPoliceResult] = useState(null);
  const [roleAck, setRoleAck] = useState(false);

  useEffect(() => {
    socket.on('connect', () => { setMe(p => ({...p, id: socket.id})); });
    socket.on('state_update', (data) => {
        setPlayers(data.players);
        setGameState(data.gameState);
        setGameConfig(data.gameConfig);
        const myData = data.players.find(p => p.id === socket.id);
        if (myData) {
            setMe(p => ({ ...p, ...myData }));
            if (data.gameState.phase === 'LOBBY' || data.gameState.phase !== 'SETUP') setView('GAME');
            if (data.gameState.phase === 'SETUP') setView('LANDING'); 
        }
        if (data.gameState.phase === 'NIGHT_POLICE') setPoliceResult(null);
    });
    socket.on('error_message', (msg) => alert(msg));
    socket.on('police_result', (r) => setPoliceResult(r));
    return () => { socket.off('connect'); socket.off('state_update'); socket.off('police_result'); };
  }, [me.id]);

  const handleCreate = () => {
       if(!gameName) return alert("Name required");
       socket.emit('create_game_setup', { name: gameName, hostName: inputName, roles: setupConfig });
  };

  const isNight = gameState.phase?.includes('NIGHT');
  const isHost = me.role === 'HOST';

  if (view === 'LANDING') {
      return (
          <div className="container">
              <h1>MAFIA <span style={{color: 'var(--accent-red)'}}>LAN</span></h1>
              <div className="card">
                  <input className="input-primary"
                    value={inputName} onChange={e => setInputName(e.target.value)} placeholder="ENTER CODENAME" maxLength={12}/>
                  
                  {gameConfig.isCreated ? (
                      <button className="btn btn-primary" onClick={() => { if(!inputName)return alert("Name!"); socket.emit('join_game', { name: inputName })}}>
                          JOIN: {gameConfig.gameName}
                      </button>
                  ) : <div style={{opacity:0.7, marginBottom:20}}>Scanning for signals... <span className="loader">...</span></div>}
                  
                  <div className="separator" style={{margin:'20px 0', borderTop:'1px solid var(--border-color)'}}></div>
                  
                  <button className="btn btn-secondary" onClick={() => {if(!inputName)return alert("Name!"); setView('SETUP')}}>
                      INITIATE NEW OPERATION
                  </button>
              </div>
          </div>
      );
  }

  if (view === 'SETUP') {
      return (
          <div className="container">
              <h1>MISSION SETUP</h1>
              <div className="card">
                  <label>Operation Name</label>
                  <input className="input-primary" value={gameName} onChange={e => setGameName(e.target.value)} />
                  
                  <div className="config-grid">
                      {['terrorist','police','doctor', 'villager'].map(r => (
                          <div key={r} className="config-item">
                              <label>{r}</label>
                              <input className="input-primary" type="number" style={{textAlign:'center', marginBottom:0}} 
                                value={setupConfig[r]} onChange={e => setSetupConfig({...setupConfig, [r]: parseInt(e.target.value) || 0})} />
                          </div>
                      ))}
                  </div>
                  <button className="btn btn-primary" style={{marginTop:20}} onClick={handleCreate}>INITIALIZE LOBBY</button>
                  <button className="btn btn-secondary" onClick={() => setView('LANDING')}>ABORT</button>
              </div>
          </div>
      );
  }

  // --- GAME VIEW ---
  return (
      <div className={`container ${isNight ? 'night-mode' : 'day-mode'}`}>
          <SkyParams isNight={isNight} />
          
          <div className="top-bar">
              <div className="phase-badge">{gameState.phase?.replace('_', ' ')}</div>
              {!isHost && (roleAck || gameState.phase !== 'ROLE_REVEAL') && me.role && (
                  <div className="role-badge">{me.role}</div>
              )}
          </div>

          {gameState.phase === 'LOBBY' && (
              <div className="card">
                  <h1>{gameConfig.gameName}</h1>
                  <h3>AGENTS: {players.length}</h3>
                  <div className="player-list">
                      {players.map(p => <div key={p.id} className="player-item">{p.name} {p.isHost && '👑'}</div>)}
                  </div>
                  {isHost ? <button className="btn btn-primary" onClick={() => socket.emit('start_game')}>COMMENCE MISSION</button> : <p>Waiting for command...</p>}
              </div>
          )}

          {gameState.phase === 'ROLE_REVEAL' && (
              isHost ? (
                  <div className="card">
                      <h2>ASSIGNING IDENTITIES...</h2>
                      <div className="player-list">{players.filter(p=>!p.isHost).map(p => (<div key={p.id} className="player-item" style={{borderColor: p.roleViewed ? 'var(--accent-green)' : 'var(--accent-red)', opacity: p.roleViewed ? 1 : 0.5}}>{p.name} {p.roleViewed ? '✅' : '⏳'}</div>))}</div>
                      <button className="btn btn-primary" disabled={players.some(p => !p.isHost && !p.roleViewed)} onClick={() => socket.emit('start_night')}>PROCEED TO NIGHT</button>
                  </div>
              ) : !roleAck ? (
                  <div style={{zIndex:2, width:'100%'}}><RoleFlipCard role={me.role} details={me.roleDetails} onDismiss={() => { setRoleAck(true); socket.emit('ack_role'); }} /></div>
              ) : (
                  <div className="card"><h2>IDENTITY SECURED</h2><p>Waiting for others...</p></div>
              )
          )}
          
          {gameState.phase !== 'LOBBY' && gameState.phase !== 'ROLE_REVEAL' && (
               <div style={{width:'100%', display:'flex', justifyContent:'center', zIndex:2}}>
                  <GameView isHost={isHost} me={me} gameState={gameState} players={players} policeResult={policeResult} />
               </div>
          )}
      </div>
  );
}

const GameView = ({ isHost, me, gameState, players, policeResult }) => {
    const [tempSelection, setTempSelection] = useState(null);
    useEffect(() => { setTempSelection(null); }, [gameState.phase]);

    const handleSelect = (id) => setTempSelection(id);
    const handleConfirm = (actionEvent) => {
        if (!tempSelection) return;
        socket.emit(actionEvent, tempSelection);
        setTempSelection(null); 
    };

    if (isHost) {
        let script = "";
        if (gameState.phase === 'NIGHT_TERRORIST') script = "Host: \"Villagers go to sleep... Terrorists, open your eyes and choose a victim.\"";
        if (gameState.phase === 'NIGHT_POLICE') script = "Host: \"Terrorists close your eyes. Police, open your eyes and suspect someone.\"";
        if (gameState.phase === 'NIGHT_DOCTOR') script = "Host: \"Police close your eyes. Doctor, open your eyes and save someone.\"";
        if (gameState.phase === 'DAY_ANNOUNCE') script = "Host: \"Everyone wake up!\"";

        return <div className="card host-panel">
            <h3>HOST COMMAND</h3>
            <div className="script-box">
                <p>{script}</p>
            </div>
            
            <div style={{fontSize:'0.9rem', background:'rgba(0,0,0,0.5)', padding:'12px', textAlign:'left', margin:'10px 0', borderRadius:8}}>
                <div>Terr Target: {players.find(p=>p.id===gameState.nightActions?.terroristSelection)?.name || '-'}</div>
                <div>Pol Suspect: {players.find(p=>p.id===gameState.nightActions?.policeSelection)?.name || '-'}</div>
                <div>Doc Save: {players.find(p=>p.id===gameState.nightActions?.doctorSelection)?.name || '-'}</div>
            </div>

            {gameState.phase === 'NIGHT_TERRORIST' && <button className="btn btn-primary" onClick={() => socket.emit('host_confirm_terrorist')}>CONFIRM & NEXT</button>}
            {gameState.phase === 'NIGHT_POLICE' && <button className="btn btn-primary" onClick={() => socket.emit('host_confirm_police')}>CONFIRM & NEXT</button>}
            {gameState.phase === 'NIGHT_DOCTOR' && <button className="btn btn-primary" onClick={() => socket.emit('host_confirm_doctor')}>CONFIRM & WAKE UP</button>}
            {gameState.phase === 'DAY_ANNOUNCE' && <button className="btn btn-primary" onClick={() => socket.emit('start_discussion')}>START DISCUSSION</button>}
            {gameState.phase === 'DAY_DISCUSSION' && <button className="btn btn-primary" onClick={() => socket.emit('start_voting')}>START VOTING</button>}
            {gameState.phase === 'DAY_VOTE' && <button className="btn btn-danger" onClick={() => socket.emit('finalize_vote')}>FINALIZE VOTES</button>}
            {gameState.phase === 'DAY_ELIMINATION' && <button className="btn btn-primary" onClick={() => socket.emit('next_round')}>START NEXT NIGHT</button>}
            {gameState.phase === 'GAME_OVER' && <button className="btn btn-primary" onClick={() => socket.emit('close_game')}>CLOSE GAME</button>}
        </div>;
    }
    
    if (!me.isAlive) return <div className="dead-overlay"><h1>TERMINATED</h1><p>You may watch in silence.</p></div>;

    if (gameState.phase?.includes('NIGHT')) {
        const roleMap = { 'TERRORIST': 'NIGHT_TERRORIST', 'POLICE': 'NIGHT_POLICE', 'DOCTOR': 'NIGHT_DOCTOR' };
        if (gameState.phase !== roleMap[me.role]) return <Suspense msg="Waiting for other roles..." />;

        let title = "ACTION REQUIRED", actionEvt = "";
        if (me.role === 'TERRORIST') { title="CHOOSE VICTIM"; actionEvt="terrorist_select"; }
        if (me.role === 'POLICE') { title="SUSPECT SOMEONE"; actionEvt="police_select"; }
        if (me.role === 'DOCTOR') { title="SAVE SOMEONE"; actionEvt="doctor_select"; }

        return <div className="card">
            <h3>{title}</h3>
            {me.role === 'POLICE' && policeResult ? (
                 <div className="result-reveal">
                    <h2>TARGET IS: <span style={{color:policeResult.isTerrorist?'red':'green'}}>{policeResult.isTerrorist?'TERRORIST':'INNOCENT'}</span></h2>
                 </div>
            ) : (
                <>
                <SelectionGrid players={players} onSelect={handleSelect} currentSelection={gameState.nightActions?.[`${me.role.toLowerCase()}Selection`]} tempSelection={tempSelection}/>
                <button className="btn btn-primary" disabled={!tempSelection} onClick={() => handleConfirm(actionEvt)}>CONFIRM SELECTION</button>
                </>
            )}
        </div>;
    }

    if (gameState.phase === 'DAY_ANNOUNCE') return <div className="card reveal-card">
        <h1>SUNRISE</h1>
        <div className="reveal-content">
            <h2>{gameState.victim ? `${players.find(p=>p.id===gameState.victim)?.name} has been killed.` : 'Peaceful Night. No one died.'}</h2>
        </div>
    </div>;

    if (gameState.phase === 'DAY_DISCUSSION') return <div className="card"><h1>DISCUSSION</h1><p>{gameState.message || "Discuss!"}</p></div>;
    
    if (gameState.phase === 'DAY_VOTE') return <div className="card">
        <h3>VOTE TO ELIMINATE</h3>
        <SelectionGrid players={players} onSelect={handleSelect} currentSelection={gameState.dayVotes && gameState.dayVotes[me.id]} tempSelection={tempSelection} />
        <button className="btn btn-danger" disabled={!tempSelection} onClick={() => socket.emit('cast_vote', {voterId:me.id, targetId:tempSelection})}>CONFIRM VOTE</button>
    </div>;

    if (gameState.phase === 'DAY_ELIMINATION') return <div className="card" style={{color:'var(--accent-red)'}}><h1>ELIMINATED</h1><h2>{players.find(p=>p.id===gameState.eliminated)?.name}</h2></div>;
    if (gameState.phase === 'GAME_OVER') return <div className="card"><h1>VICTORY FOR {gameState.winner}</h1></div>;

    return null;
}

const Suspense = ({msg}) => <div className="suspense-screen"><h1 style={{animation: 'pulse 2s infinite', fontSize:'1.5rem', opacity:0.7, marginTop:100}}>{msg}</h1></div>;

export default App
