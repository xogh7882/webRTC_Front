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
    console.log('Processing message type:', message.type);
    
    switch (message.type) {
      case 'connected':
        setStatus('WebSocket Connected as ' + userId);
        break;
        
      case 'room-joined':
        setStatus('Joined room: ' + (message.roomId || 'unknown'));
        if (message.message && message.message.includes('Participants:')) {
          const count = parseInt(message.message.split('Participants: ')[1]);
          setParticipants(count);
        }
        
        // Room 조인 성공 후 미디어 시작
        try {
          const stream = await startLocalVideo();
          if (stream) {
            await createPeerConnection(stream);
          }
        } catch (error) {
          console.error('Error starting media after room join:', error);
          setStatus('Media Error: ' + error.message);
        }
        break;
        
      case 'user-joined':
        setStatus('New user joined the room');
        setParticipants(prev => prev + 1);
        // 새 사용자가 들어오면 Offer 재전송
        if (peerConnectionRef.current && localStreamRef.current) {
          setTimeout(() => sendOffer(), 1000);
        }
        break;
        
      case 'user-left':
        setStatus('User left the room');
        setParticipants(prev => Math.max(0, prev - 1));
        break;
        
      case 'answer':
        if (message.sdp) {
          await handleAnswer(message.sdp);
        } else {
          console.error('Received answer without SDP');
        }
        break;
        
      case 'remote-offer':
        // 다른 클라이언트로부터의 Offer 처리
        if (message.sdp && peerConnectionRef.current) {
          await handleRemoteOffer(message.sdp, message.fromSession);
        }
        break;
        
      case 'remote-answer':
        // 다른 클라이언트로부터의 Answer 처리
        if (message.sdp && peerConnectionRef.current) {
          await handleRemoteAnswer(message.sdp, message.fromSession);
        }
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
        setStatus('Error: ' + (message.message || 'Unknown error'));
        break;
        
      default:
        console.log('Unknown message type:', message.type);
    }
  };

  const startCall = async () => {
    try {
      if (!connected || !ws) {
        setStatus('WebSocket not connected. Please connect first.');
        return;
      }

      if (!roomId || roomId.trim() === '') {
        setStatus('Please enter a room ID');
        return;
      }

      // Room에 조인
      sendMessage({
        type: 'join-room',
        roomId: roomId.trim()
      });

      setStatus('Joining room...');

    } catch (error) {
      console.error('Error starting call:', error);
      setStatus('Error starting call: ' + error.message);
    }
  };

  const startLocalVideo = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      localStreamRef.current = stream;
      setStatus('Camera Ready - ' + userId);
      
      return stream;
    } catch (error) {
      console.error('Error accessing media devices:', error);
      setStatus('Media Access Denied');
      throw error;
    }
  };

  const createPeerConnection = async (stream) => {
    try {
      const pc = new RTCPeerConnection({ iceServers });
      
      // 로컬 스트림 추가
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
        console.log('Added local track:', track.kind);
      });
      
      // 원격 스트림 처리
      pc.ontrack = (event) => {
        console.log('Remote stream received:', event.streams[0]);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
        setStatus(userId + ' - Connected with remote peer');
      };
      
      // ICE candidate 처리
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Sending ICE candidate:', event.candidate.candidate);
          sendMessage({
            type: 'ice-candidate',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            roomId: roomId
          });
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus(userId + ' - WebRTC Connected');
        } else if (pc.connectionState === 'failed') {
          setStatus(userId + ' - Connection Failed');
        } else if (pc.connectionState === 'disconnected') {
          setStatus(userId + ' - Connection Lost');
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setStatus(userId + ' - Video call active');
        }
      };
      
      peerConnectionRef.current = pc;
      setInCall(true);
      
      // 다른 참가자가 있을 때만 즉시 Offer 전송
      if (participants > 0) {
        await sendOffer();
      }
      
    } catch (error) {
      console.error('Error creating peer connection:', error);
      setStatus('WebRTC Error: ' + error.message);
    }
  };

  const sendOffer = async () => {
    try {
      if (!peerConnectionRef.current) return;
      
      const offer = await peerConnectionRef.current.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await peerConnectionRef.current.setLocalDescription(offer);
      
      console.log('Sending offer:', offer);
      sendMessage({
        type: 'offer',
        sdp: offer.sdp,
        roomId: roomId
      });
      
      setStatus(userId + ' - Calling...');
      
    } catch (error) {
      console.error('Error sending offer:', error);
      setStatus('Offer Error: ' + error.message);
    }
  };

  const handleAnswer = async (sdp) => {
    try {
      console.log('Received answer:', sdp.substring(0, 100) + '...');
      
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

  const handleRemoteOffer = async (sdp, fromSession) => {
    try {
      console.log('Received remote offer from:', fromSession);
      
      if (!peerConnectionRef.current) {
        console.error('No peer connection available');
        return;
      }
      
      const offer = new RTCSessionDescription({
        type: 'offer',
        sdp: sdp
      });
      
      await peerConnectionRef.current.setRemoteDescription(offer);
      
      // Answer 생성 및 전송
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      
      console.log('Sending answer to remote peer');
      sendMessage({
        type: 'remote-answer',
        sdp: answer.sdp,
        toSession: fromSession,
        roomId: roomId
      });
      
      setStatus(userId + ' - Answering call from remote peer');
      
    } catch (error) {
      console.error('Error handling remote offer:', error);
      setStatus('Remote Offer Error: ' + error.message);
    }
  };

  const handleRemoteAnswer = async (sdp, fromSession) => {
    try {
      console.log('Received remote answer from:', fromSession);
      
      if (!peerConnectionRef.current) {
        console.error('No peer connection available');
        return;
      }
      
      const answer = new RTCSessionDescription({
        type: 'answer',
        sdp: sdp
      });
      
      await peerConnectionRef.current.setRemoteDescription(answer);
      setStatus(userId + ' - Connected to remote peer');
      
    } catch (error) {
      console.error('Error handling remote answer:', error);
      setStatus('Remote Answer Error: ' + error.message);
    }
  };

  const handleIceCandidate = async (message) => {
    try {
      if (!message.candidate || !message.sdpMid || message.sdpMLineIndex === undefined) {
        console.error('Invalid ICE candidate message:', message);
        return;
      }

      if (!peerConnectionRef.current) {
        console.error('No peer connection available for ICE candidate');
        return;
      }
      
      const candidate = new RTCIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex
      });
      
      await peerConnectionRef.current.addIceCandidate(candidate);
      console.log('Added ICE candidate from:', message.fromSession || 'server');
      
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
        type: 'end-call',
        roomId: roomId
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket is not connected');
      setStatus('WebSocket not connected');
      return;
    }
    
    // 필수 필드 검증
    if (!message.type) {
      console.error('Message type is required');
      return;
    }
    
    console.log('Sending message:', message.type, message);
    ws.send(JSON.stringify(message));
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
            <li>Wait for WebRTC connection to establish</li>
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

        <div className="debug-info">
          <h4>Debug Info:</h4>
          <p>WebSocket: {connected ? '🟢 Connected' : '🔴 Disconnected'}</p>
          <p>WebRTC: {inCall ? '🟢 Active' : '🔴 Inactive'}</p>
          <p>Room: {roomId}</p>
        </div>
      </header>
    </div>
  );
}

export default App;