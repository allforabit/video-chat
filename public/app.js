function logIt(message, error) {
  // Print on console
  console.log(message);

  // Add to logs on page
  let logs = document.getElementById("logs");
  let tmp = document.createElement("P");
  tmp.innerText = message;
  if (error) {
    tmp.classList.add("error");
  }
  logs.appendChild(tmp);
}

// Create an object to save various objects to without polluting the global
// namespace.
var Chat = {
  connected: false,
  localICECandidates: [],

  // Initialise our connection to the WebSocket.
  socket: io(),

  // The onMediaStream function receives the media stream as an argument.
  join: function () {
    Chat.joinButton.setAttribute("disabled", "disabled");
    // Add the stream as video's srcObject.
    // As the video has the `autoplay` attribute it will start to stream immediately.
    // Now we're ready to join the chat room.
    Chat.socket.emit("join", "test");
    Chat.socket.on("ready", Chat.readyToCall);
    Chat.socket.on("offer", Chat.onOffer);
  },

  // When we are ready to call, enable the Call button.
  readyToCall: function (event) {
    Chat.callButton.removeAttribute("disabled");
  },

  // Set up a callback to run when we have the ephemeral token to use Twilio's
  // TURN server.
  // I think this will be the host
  startCall: function (event) {
    logIt(">>> Sending token request...");
    Chat.socket.on("token", Chat.onToken(Chat.createOffer));
    Chat.socket.emit("token");
  },

  // When we receive the ephemeral token back from the server.
  onToken: function (callback) {
    return function (token) {
      logIt("<<< Received token");
      // Set up a new RTCPeerConnection using the token's iceServers.
      Chat.peerConnection = new RTCPeerConnection({
        iceServers: token.iceServers,
      });

      // Set up callbacks for the connection generating iceCandidates or
      // receiving the remote media stream.
      Chat.peerConnection.onicecandidate = Chat.onIceCandidate;
      // Set up listeners on the socket for candidates or answers being passed
      // over the socket connection.
      Chat.socket.on("candidate", Chat.onCandidate);
      Chat.socket.on("answer", Chat.onAnswer);

      // Also create a data channel
      logIt("--- Create data channel");
      Chat.dataChannel = Chat.peerConnection.createDataChannel("chat", {});

      Chat.dataChannel.addEventListener("open", () => {
        logIt("--- Host data channel open!!!");
      });

      Chat.dataChannel.addEventListener("close", () => {
        logIt("--- Host data channel closed!!!");
      });

      Chat.dataChannel.addEventListener("message", Chat.onReceiveMsg);

      callback();
    };
  },

  // When the peerConnection generates an ice candidate, send it over the socket
  // to the peer.
  onIceCandidate: function (event) {
    if (event.candidate) {
      logIt(
        `<<< Received local ICE candidate from STUN/TURN server (${event.candidate.address})`
      );
      if (Chat.connected) {
        logIt(`>>> Sending local ICE candidate (${event.candidate.address})`);
        Chat.socket.emit("candidate", JSON.stringify(event.candidate));
      } else {
        // If we are not 'connected' to the other peer, we are buffering the local ICE candidates.
        // This most likely is happening on the "caller" side.
        // The peer may not have created the RTCPeerConnection yet, so we are waiting for the 'answer'
        // to arrive. This will signal that the peer is ready to receive signaling.
        Chat.localICECandidates.push(event.candidate);
      }
    }
  },

  // When receiving a candidate over the socket, turn it back into a real
  // RTCIceCandidate and add it to the peerConnection.
  onCandidate: function (candidate) {
    rtcCandidate = new RTCIceCandidate(JSON.parse(candidate));
    logIt(
      `<<< Received remote ICE candidate (${rtcCandidate.address} - ${rtcCandidate.relatedAddress})`
    );
    Chat.peerConnection.addIceCandidate(rtcCandidate);
  },

  // Create an offer that contains the media capabilities of the browser.
  createOffer: function () {
    logIt(">>> Creating offer...");
    Chat.peerConnection.createOffer(
      function (offer) {
        // If the offer is created successfully, set it as the local description
        // and send it over the socket connection to initiate the peerConnection
        // on the other side.
        Chat.peerConnection.setLocalDescription(offer);
        console.log({ offer });
        Chat.socket.emit("offer", JSON.stringify(offer));
      },
      function (err) {
        // Handle a failed offer creation.
        logIt(err, true);
      }
    );
  },

  // Create an answer with the media capabilities that both browsers share.
  // This function is called with the offer from the originating browser, which
  // needs to be parsed into an RTCSessionDescription and added as the remote
  // description to the peerConnection object. Then the answer is created in the
  // same manner as the offer and sent over the socket.
  createAnswer: function (offer) {
    return function () {
      logIt(">>> Creating answer...");
      Chat.connected = true;
      rtcOffer = new RTCSessionDescription(JSON.parse(offer));
      Chat.peerConnection.setRemoteDescription(rtcOffer);
      Chat.peerConnection.createAnswer(
        function (answer) {
          console.log(answer);
          Chat.peerConnection.setLocalDescription(answer);
          Chat.socket.emit("answer", JSON.stringify(answer));
        },
        function (err) {
          // Handle a failed answer creation.
          logIt(err, true);
        }
      );

      // Also listen for datachannel
      logIt("--- Setting up listener for data channel");
      Chat.peerConnection.addEventListener("datachannel", (event) => {
        logIt("--- Got data channel");
        console.log(event);
        Chat.dataChannel = event.channel;
        Chat.dataChannel.addEventListener("open", () => {
          logIt("--- Guest data channel open!!!");
        });
        Chat.dataChannel.addEventListener("close", () => {
          logIt("--- Guest data channel closed!!!");
        });
        Chat.dataChannel.addEventListener("message", Chat.onReceiveMsg);
      });
    };
  },

  // When a browser receives an offer, set up a callback to be run when the
  // ephemeral token is returned from Twilio.
  // I think this will be the guest
  onOffer: function (offer) {
    logIt("<<< Received offer");
    Chat.socket.on("token", Chat.onToken(Chat.createAnswer(offer)));
    Chat.socket.emit("token");
  },

  // When an answer is received, add it to the peerConnection as the remote
  // description.
  onAnswer: function (answer) {
    logIt("<<< Received answer");
    var rtcAnswer = new RTCSessionDescription(JSON.parse(answer));
    Chat.peerConnection.setRemoteDescription(rtcAnswer);
    Chat.connected = true;
    Chat.localICECandidates.forEach((candidate) => {
      // The caller now knows that the callee is ready to accept new
      // ICE candidates, so sending the buffer over
      logIt(`>>> Sending local ICE candidate (${candidate.address})`);
      Chat.socket.emit("candidate", JSON.stringify(candidate));
    });
    // Resest the buffer of local ICE candidates. This is not really needed
    // in this specific client, but it's good practice
    Chat.localICECandidates = [];
  },

  sendMsg: function (event) {
    event.preventDefault();
    if (Chat.dataChannel && Chat.dataChannel.readyState === "open") {
      Chat.dataChannel.send(Chat.msgInput.value);
      Chat.msgInput.value = "";
    }
    console.log(Chat.msgInput.value);
  },
  onReceiveMsg: function ({ data }) {
    Chat.receiveMsg.innerText = data;
    console.log({ event }, "message!!!!!");
  },
};

// Get the video button and add a click listener to start the getUserMedia
// process
Chat.joinButton = document.getElementById("join");
Chat.joinButton.addEventListener("click", Chat.join, false);

// Get the call button and add a click listener to start the peerConnection
Chat.callButton = document.getElementById("call");
Chat.callButton.addEventListener("click", Chat.startCall, false);

Chat.msgInput = document.getElementById("msg");
Chat.receiveMsg = document.getElementById("receive-msg");

Chat.form = document.getElementById("msg-form");

Chat.form.addEventListener("submit", Chat.sendMsg);
