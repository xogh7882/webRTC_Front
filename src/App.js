import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';
import SockJS from 'sockjs-client';

function App() {
  const [connected, setConnected] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [roomId, setRoomId] = useState('room-' + Math.random().toString(36).substr(2, 9));
  const [status, setStatus] = useState('Disconnected');
  const [participants, setParticipants] = useState(0);
  const [userId] = useState('User-' + Math.random().toString(36).substr(2, 6));
  const [isCaller, setIsCaller] = useState(false);
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const wsRef = useRef(null); // WebSocket을 ref로 관리

  // 서버 설정
  const SERVER_URL = 'http://58.76.166.46:8080';
  
  // ICE 서버 설정
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    try {
      console.log('🔌 Connecting to:', SERVER_URL);
      const socket = new SockJS(SERVER_URL + '/signaling');
      wsRef.current = socket;
      
      socket.onopen = () => {
        console.log('✅ WebSocket connected');
        setConnected(true);
        setStatus('Connected - Ready to join room');
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('📨 Received:', message);
        handleMessage(message);
      };

      socket.onclose = () => {
        console.log('❌ WebSocket disconnected');
        setConnected(false);
        setStatus('Disconnected');
        wsRef.current = null;
      };

      socket.onerror = (error) => {
        console.error('🚨 WebSocket error:', error);
        setStatus('Connection Error');
      };

    } catch (error) {
      console.error('Failed to connect:', error);
      setStatus('Connection Failed');
    }
  }, []);

  const handleMessage = useCallback(async (message) => {
    console.log('🔄 Processing message type:', message.type);
    
    switch (message.type) {
      case 'room-joined':
        const count = message.participants || 1;
        setParticipants(count);
        setStatus(`✅ Joined room (${count} participants)`);
        
        if (count === 1) {
          console.log('👤 First user in room - waiting for others');
          setIsCaller(false);
        }
        break;
        
      case 'user-joined':
        const newCount = message.participants || 2;
        setParticipants(newCount);
        setStatus(`👥 ${newCount} participants - Starting video call...`);
        
        console.log('🔍 Current WebSocket state:', wsRef.current);
        console.log('🔍 WebSocket readyState:', wsRef.current ? wsRef.current.readyState : 'null');
        
        if (newCount === 2 && !isCaller && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          console.log('🚀 Second user joined - I become the caller');
          setIsCaller(true);
          setTimeout(() => {
            console.log('🔍 Delayed WebSocket check:', wsRef.current);
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              console.log('✅ Starting delayed call');
              startCall();
            } else {
              console.log('⚠️ WebSocket not ready for delayed call');
            }
          }, 1000);
        }
        break;
        
      case 'offer':
        console.log('📞 Received offer');
        await handleOffer(message.offer);
        break;
        
      case 'answer':
        console.log('📞 Received answer');
        await handleAnswer(message.answer);
        break;
        
      case 'ice-candidate':
        console.log('🧊 Received ICE candidate');
        await handleIceCandidate(message.candidate);
        break;
        
      case 'user-left':
        const remainingCount = message.participants || 0;
        setParticipants(remainingCount);
        setStatus(`👋 User left (${remainingCount} remaining)`);
        endCall();
        break;
        
      case 'error':
        console.error('🚨 Server error:', message.message);
        setStatus('❌ Error: ' + message.message);
        break;
        
      default:
        console.log('❓ Unknown message:', message.type);
    }
  }, [isCaller]);

  const joinRoom = useCallback(async () => {
    if (!wsRef.current || !connected) {
      alert('❌ Please connect to server first!');
      return;
    }

    if (!roomId.trim()) {
      alert('❌ Please enter a room ID!');
      return;
    }

    try {
      console.log('🎥 Getting camera access...');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 }, 
        audio: true 
      });
      
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      // 로컬 트랙 추가 로그
      stream.getTracks().forEach(track => {
        console.log('➕ Added local track:', track.kind);
      });
      
      console.log('📹 Camera ready, joining room:', roomId);
      
      const message = {
        type: 'join-room',
        roomId: roomId.trim(),
        userId: userId
      };
      
      console.log('📤 Sending join-room message:', message);
      wsRef.current.send(JSON.stringify(message));
      setStatus('📞 Joining room...');
      
    } catch (error) {
      console.error('🚨 Camera access failed:', error);
      setStatus('❌ Camera access denied');
    }
  }, [connected, roomId, userId]);

  const startCall = useCallback(async () => {
    if (!localStreamRef.current) {
      console.error('❌ No local stream');
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('❌ WebSocket not ready');
      return;
    }

    try {
      console.log('🔗 Creating peer connection...');
      
      const pc = new RTCPeerConnection({ iceServers });
      peerConnectionRef.current = pc;

      // 로컬 스트림 추가
      localStreamRef.current.getTracks().forEach(track => {
        console.log('➕ Adding track:', track.kind);
        pc.addTrack(track, localStreamRef.current);
      });

      // 원격 스트림 처리
      pc.ontrack = (event) => {
        console.log('🎬 Received remote stream!');
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setStatus('🎉 Video call connected!');
        }
      };

      // ICE candidate 처리
      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          console.log('🧊 Sending ICE candidate');
          sendMessage({
            type: 'ice-candidate',
            candidate: event.candidate,
            roomId: roomId,
            userId: userId
          });
        }
      };

      // 연결 상태 모니터링
      pc.onconnectionstatechange = () => {
        console.log('🔗 Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus('✅ WebRTC connected!');
        } else if (pc.connectionState === 'failed') {
          setStatus('❌ Connection failed');
        }
      };

      // Offer 생성
      console.log('📝 Creating offer...');
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await pc.setLocalDescription(offer);
      
      console.log('📤 Sending offer');
      sendMessage({
        type: 'offer',
        offer: offer,
        roomId: roomId,
        userId: userId
      });
      
      setInCall(true);
      setStatus('📞 Calling...');
      
    } catch (error) {
      console.error('🚨 Failed to start call:', error);
      setStatus('❌ Call failed: ' + error.message);
    }
  }, [roomId, userId]);

  const handleOffer = useCallback(async (offer) => {
    if (!localStreamRef.current) {
      console.error('❌ No local stream for answer');
      return;
    }

    try {
      console.log('📞 Handling offer...');
      
      const pc = new RTCPeerConnection({ iceServers });
      peerConnectionRef.current = pc;

      // 로컬 스트림 추가
      localStreamRef.current.getTracks().forEach(track => {
        console.log('➕ Adding track for answer:', track.kind);
        pc.addTrack(track, localStreamRef.current);
      });

      // 원격 스트림 처리
      pc.ontrack = (event) => {
        console.log('🎬 Received remote stream in answer!');
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setStatus('🎉 Video call connected!');
        }
      };

      // ICE candidate 처리
      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          console.log('🧊 Sending ICE candidate from answerer');
          sendMessage({
            type: 'ice-candidate',
            candidate: event.candidate,
            roomId: roomId,
            userId: userId
          });
        }
      };

      // 연결 상태 모니터링
      pc.onconnectionstatechange = () => {
        console.log('🔗 Connection state (answerer):', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus('✅ WebRTC connected!');
        }
      };

      // Offer 처리 및 Answer 생성
      console.log('📝 Setting remote description and creating answer...');
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      console.log('📤 Sending answer');
      sendMessage({
        type: 'answer',
        answer: answer,
        roomId: roomId,
        userId: userId
      });
      
      setInCall(true);
      setStatus('📞 Answering call...');
      
    } catch (error) {
      console.error('🚨 Failed to handle offer:', error);
      setStatus('❌ Answer failed: ' + error.message);
    }
  }, [roomId, userId]);

  const handleAnswer = useCallback(async (answer) => {
    if (!peerConnectionRef.current) {
      console.error('❌ No peer connection for answer');
      return;
    }

    try {
      console.log('📝 Setting remote description from answer...');
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      setStatus('📞 Call answered - connecting...');
    } catch (error) {
      console.error('🚨 Failed to set remote description:', error);
      setStatus('❌ Failed to connect');
    }
  }, []);

  const handleIceCandidate = useCallback(async (candidate) => {
    if (!peerConnectionRef.current) {
      console.error('❌ No peer connection for ICE candidate');
      return;
    }

    try {
      console.log('🧊 Adding ICE candidate...');
      await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('🚨 Failed to add ICE candidate:', error);
    }
  }, []);

  const leaveRoom = useCallback(() => {
    if (wsRef.current && connected) {
      sendMessage({
        type: 'leave-room',
        roomId: roomId,
        userId: userId
      });
    }
    
    endCall();
    setParticipants(0);
    setIsCaller(false);
    setStatus(connected ? 'Connected - Ready to join room' : 'Disconnected');
  }, [connected, roomId, userId]);

  const endCall = useCallback(() => {
    console.log('🔚 Ending call...');
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    
    setInCall(false);
    setIsCaller(false);
  }, []);

  const sendMessage = useCallback((message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log('📤 Sending:', message.type);
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('❌ WebSocket not connected. ReadyState:', wsRef.current ? wsRef.current.readyState : 'null');
    }
  }, []);

  const disconnectWebSocket = useCallback(() => {
    cleanup();
    setConnected(false);
    setStatus('Disconnected');
  }, [cleanup]);

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎥 WebRTC Video Chat</h1>
        
        <div className="info-panel">
          <p><strong>🌐 Server:</strong> {SERVER_URL}</p>
          <p><strong>📊 Status:</strong> <span className={connected ? 'connected' : 'disconnected'}>{status}</span></p>
          <p><strong>👤 User ID:</strong> {userId}</p>
          <p><strong>🏠 Room ID:</strong> {roomId}</p>
          <p><strong>👥 Participants:</strong> {participants}</p>
          <p><strong>📞 Role:</strong> {isCaller ? '📲 Caller' : '📱 Receiver'}</p>
          <p><strong>🔌 WebSocket:</strong> {wsRef.current ? (wsRef.current.readyState === WebSocket.OPEN ? '✅ Open' : '⚠️ Not Open') : '❌ Null'}</p>
        </div>
        
        <div className="controls">
          <div className="room-input">
            <input 
              type="text" 
              value={roomId} 
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Enter Room ID"
              disabled={participants > 0}
              style={{
                padding: '10px', 
                fontSize: '16px', 
                width: '200px',
                marginRight: '10px'
              }}
            />
          </div>
          
          <div className="action-buttons">
            {!connected ? (
              <button onClick={connectWebSocket} style={{backgroundColor: '#4CAF50'}}>
                🔌 Connect to Server
              </button>
            ) : (
              <button onClick={disconnectWebSocket} style={{backgroundColor: '#f44336'}}>
                🔌 Disconnect
              </button>
            )}
            
            {connected && participants === 0 && (
              <button onClick={joinRoom} style={{backgroundColor: '#2196F3'}}>
                🚪 Join Room
              </button>
            )}
            
            {connected && participants > 0 && (
              <button onClick={leaveRoom} style={{backgroundColor: '#FF9800'}}>
                🚪 Leave Room
              </button>
            )}
          </div>
        </div>
        
        <div className="test-guide">
          <h3>🧪 Test Steps:</h3>
          <ol style={{textAlign: 'left', maxWidth: '500px', margin: '0 auto'}}>
            <li><strong>Both users:</strong> Click "🔌 Connect to Server"</li>
            <li><strong>Both users:</strong> Enter the <strong>SAME Room ID</strong></li>
            <li><strong>Both users:</strong> Click "🚪 Join Room"</li>
            <li><strong>Allow camera access</strong> when prompted</li>
            <li><strong>Wait</strong> - Second user will auto-start call</li>
            <li><strong>Check console (F12)</strong> for debug info</li>
          </ol>
        </div>
        
        <div className="video-container">
          <div className="video-box">
            <h3>🎥 Your Video ({userId})</h3>
            <video 
              ref={localVideoRef} 
              autoPlay 
              muted 
              playsInline
              style={{
                width: '320px', 
                height: '240px', 
                border: '3px solid #4CAF50',
                borderRadius: '10px',
                backgroundColor: '#000'
              }}
            />
          </div>
          
          <div className="video-box">
            <h3>📺 Remote Video</h3>
            <video 
              ref={remoteVideoRef} 
              autoPlay 
              playsInline
              style={{
                width: '320px', 
                height: '240px', 
                border: '3px solid #2196F3',
                borderRadius: '10px',
                backgroundColor: '#000'
              }}
            />
          </div>
        </div>
      </header>
    </div>
  );
}

export default App;