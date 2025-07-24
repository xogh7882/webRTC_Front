import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import SockJS from 'sockjs-client';

function App() {
  const [ws, setWs] = useState(null);
  const [connected, setConnected] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [roomId, setRoomId] = useState('room-' + Math.random().toString(36).substr(2, 9));
  const [status, setStatus] = useState('Disconnected');
  const [participants, setParticipants] = useState(0);
  const [userId] = useState('User-' + Math.random().toString(36).substr(2, 6));
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);

  // ICE 서버 설정 (STUN/TURN)
  const iceServers = [
    { urls: 'stun:localhost:3478' },
    { urls: 'stun:stun.l.google.com:19302' } // 백업 STUN 서버
  ];

  useEffect(() => {
    return () => {
      if (ws) {
        ws.close();
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [ws]);

  const connectWebSocket = () => {
    try {
      const socket = new SockJS('http://localhost:8080/signaling');
      
      socket.onopen = () => {
        console.log('WebSocket connected');
        setConnected(true);
        setStatus('Connected as ' + userId);
        setWs(socket);
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('Received message:', message);
        handleSignalingMessage(message);
      };

      socket.onclose = () => {
        console.log('WebSocket disconnected');
        setConnected(false);
        setStatus('Disconnected');
        setWs(null);
      };

      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        setStatus('Connection Error');
      };

    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setStatus('Connection Failed');
    }
  };

  const disconnectWebSocket = () => {
    if (ws) {
      ws.close();
    }
  };

  const handleSignalingMessage = async (message) => {
    switch (message.type) {
      case 'connected':
        setStatus('WebSocket Connected as ' + userId);
        break;
        
      case 'room-joined':
        setStatus('Joined room: ' + message.roomId);
        // 참가자 수 파싱
        if (message.message && message.message.includes('Participants:')) {
          const count = parseInt(message.message.split('Participants: ')[1]);
          setParticipants(count);
        }
        break;
        
      case 'user-joined':
        setStatus('New user joined the room');
        setParticipants(prev => prev + 1);
        break;
        
      case 'user-left':
        setStatus('User left the room');
        setParticipants(prev => Math.max(0, prev - 1));
        break;
        
      case 'answer':
        await handleAnswer(message.sdp);
        break;
        
      case 'ice-candidate':
        await handleIceCandidate(message);
        break;
        
      case 'call-started':
        setStatus('Call Started');
        break;
        
      case 'call-ended':
        setStatus('Call Ended');
        endCall();
        break;
        
      case 'error':
        console.error('Server error:', message.message);
        setStatus('Error: ' + message.message);
        break;
        
      default:
        console.log('Unknown message type:', message.type);
    }
  };

  const joinRoom = () => {
    if (ws && roomId.trim()) {
      sendMessage({
        type: 'join-room',
        roomId: roomId.trim()
      });
    }
  };

  const startLocalVideo = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      
      localVideoRef.current.srcObject = stream;
      localStreamRef.current = stream;
      setStatus('Camera Ready - ' + userId);
      
      return stream;
    } catch (error) {
      console.error('Error accessing media devices:', error);
      setStatus('Media Access Denied');
      throw error;
    }
  };

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection({ iceServers });
    
    // ICE 후보자 이벤트
    pc.onicecandidate = (event) => {
      if (event.candidate && ws) {
        console.log('Sending ICE candidate:', event.candidate);
        sendMessage({
          type: 'ice-candidate',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          roomId: roomId
        });
      }
    };

    // 원격 스트림 수신
    pc.ontrack = (event) => {
      console.log('Received remote stream:', event.streams[0]);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // 연결 상태 모니터링
    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      setStatus(userId + ' - Connection: ' + pc.connectionState);
      
      if (pc.connectionState === 'connected') {
        setStatus(userId + ' - Connected to room: ' + roomId);
      }
    };

    // ICE 연결 상태 모니터링
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setStatus(userId + ' - Video call active');
      }
    };

    return pc;
  };

  const startCall = async () => {
    try {
      setStatus('Starting call...');
      
      // 먼저 룸에 참가
      joinRoom();
      
      // 로컬 비디오 스트림 획득
      const stream = await startLocalVideo();
      
      // PeerConnection 생성
      const pc = createPeerConnection();
      peerConnectionRef.current = pc;
      
      // 로컬 스트림을 PeerConnection에 추가
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // SDP Offer 생성
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      console.log('Created offer:', offer);
      
      // 서버로 Offer 전송
      sendMessage({
        type: 'offer',
        sdp: offer.sdp,
        roomId: roomId
      });
      
      setInCall(true);
      setStatus(userId + ' - Calling...');
      
    } catch (error) {
      console.error('Error starting call:', error);
      setStatus('Call Failed: ' + error.message);
    }
  };

  const handleAnswer = async (sdp) => {
    try {
      console.log('Received answer:', sdp);
      
      const answer = new RTCSessionDescription({
        type: 'answer',
        sdp: sdp
      });
      
      await peerConnectionRef.current.setRemoteDescription(answer);
      setStatus(userId + ' - Call Connected');
      
    } catch (error) {
      console.error('Error handling answer:', error);
      setStatus('Answer Error: ' + error.message);
    }
  };

  const handleIceCandidate = async (message) => {
    try {
      const candidate = new RTCIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex
      });
      
      await peerConnectionRef.current.addIceCandidate(candidate);
      console.log('Added ICE candidate');
      
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  };

  const endCall = () => {
    // PeerConnection 정리
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // 로컬 스트림 정리
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    // 비디오 엘리먼트 정리
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    
    // 서버에 통화 종료 알림
    if (ws && inCall) {
      sendMessage({
        type: 'end-call'
      });
      
      sendMessage({
        type: 'leave-room',
        roomId: roomId
      });
    }
    
    setInCall(false);
    setParticipants(0);
    setStatus(connected ? 'Connected as ' + userId : 'Disconnected');
  };

  const sendMessage = (message) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
    }
  };

  const generateNewRoomId = () => {
    const newRoomId = 'room-' + Math.random().toString(36).substr(2, 9);
    setRoomId(newRoomId);
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId).then(() => {
      setStatus('Room ID copied to clipboard!');
      setTimeout(() => {
        setStatus(connected ? 'Connected as ' + userId : 'Disconnected');
      }, 2000);
    });
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>WebRTC Multi-User Video Call</h1>
        
        <div className="user-info">
          <p>Your ID: <strong>{userId}</strong></p>
          <p>Participants in room: <strong>{participants}</strong></p>
        </div>
        
        <div className="status">
          <p>Status: <span className={connected ? 'connected' : 'disconnected'}>{status}</span></p>
        </div>

        <div className="controls">
          <div className="connection-controls">
            {!connected ? (
              <button onClick={connectWebSocket}>Connect to Server</button>
            ) : (
              <button onClick={disconnectWebSocket}>Disconnect</button>
            )}
          </div>

          <div className="room-controls">
            <label>
              Room ID: 
              <input 
                type="text" 
                value={roomId} 
                onChange={(e) => setRoomId(e.target.value)}
                disabled={inCall}
                placeholder="Enter room ID or generate new one"
              />
            </label>
            <button onClick={generateNewRoomId} disabled={inCall}>New Room</button>
            <button onClick={copyRoomId}>Copy Room ID</button>
          </div>

          <div className="call-controls">
            {connected && !inCall && (
              <button onClick={startCall} className="start-call">Join Room & Start Call</button>
            )}
            {inCall && (
              <button onClick={endCall} className="end-call">Leave Room</button>
            )}
          </div>
        </div>

        <div className="instructions">
          <h3>How to test with another person:</h3>
          <ol>
            <li>Share your Room ID with someone else</li>
            <li>Both click "Connect to Server"</li>
            <li>Enter the same Room ID</li>
            <li>Both click "Join Room & Start Call"</li>
            <li>Allow camera/microphone access</li>
          </ol>
        </div>

        <div className="video-container">
          <div className="video-box">
            <h3>Your Video ({userId})</h3>
            <video 
              ref={localVideoRef} 
              autoPlay 
              muted 
              playsInline
              width="300" 
              height="200"
            />
          </div>
          
          <div className="video-box">
            <h3>Remote Video</h3>
            <video 
              ref={remoteVideoRef} 
              autoPlay 
              playsInline
              width="300" 
              height="200"
            />
          </div>
        </div>
      </header>
    </div>
  );
}

export default App;