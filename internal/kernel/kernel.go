package kernel

import (
	"context"
	"fmt"
	"log"
	"sync"

	zmq "github.com/go-zeromq/zmq4"
	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/ide"
	"github.com/hugr-lab/hugr-kernel/internal/meta"
	"github.com/hugr-lab/hugr-kernel/internal/result"
	"github.com/hugr-lab/hugr-kernel/internal/session"
)

// ConnectionInfo holds the parsed Jupyter connection file data.
type ConnectionInfo struct {
	Transport       string `json:"transport"`
	IP              string `json:"ip"`
	ShellPort       int    `json:"shell_port"`
	ControlPort     int    `json:"control_port"`
	IOPubPort       int    `json:"iopub_port"`
	StdinPort       int    `json:"stdin_port"`
	HBPort          int    `json:"hb_port"`
	Key             string `json:"key"`
	SignatureScheme string `json:"signature_scheme"`
}

// Endpoint returns the ZMQ endpoint string for a given port.
func (c *ConnectionInfo) Endpoint(port int) string {
	return fmt.Sprintf("%s://%s:%d", c.Transport, c.IP, port)
}

// Kernel manages the Jupyter kernel lifecycle and ZMQ sockets.
type Kernel struct {
	connInfo    *ConnectionInfo
	session     *session.Session
	connManager *connection.Manager
	spool       *result.Spool
	arrowServer *ArrowServer
	metaReg     *meta.Registry
	ide         *ide.Service
	key         []byte

	shellSocket   zmq.Socket
	controlSocket zmq.Socket
	iopubSocket   zmq.Socket
	iopubMu       sync.Mutex // protects concurrent writes to iopubSocket
	stdinSocket   zmq.Socket
	hbSocket      zmq.Socket

	commReg *commRegistry // tracks active comm channels

	cancel context.CancelFunc // set by Start, used by shutdown_request
}

// NewKernel creates a new kernel with the given connection info.
func NewKernel(connInfo *ConnectionInfo, sess *session.Session, cm *connection.Manager, sp *result.Spool, reg *meta.Registry) *Kernel {
	return &Kernel{
		connInfo:    connInfo,
		session:     sess,
		connManager: cm,
		spool:       sp,
		metaReg:     reg,
		ide:         ide.NewService(cm),
		key:         []byte(connInfo.Key),
		commReg:     newCommRegistry(),
	}
}

// InvalidateIDECache clears all cached IDE data (completion, hover, explorer).
func (k *Kernel) InvalidateIDECache() {
	k.ide.InvalidateCache()
}

// Start initializes ZMQ sockets and begins the message loop.
func (k *Kernel) Start(ctx context.Context) error {
	// Wrap context so shutdown_request can cancel it.
	ctx, k.cancel = context.WithCancel(ctx)
	defer k.cancel()

	var err error

	k.hbSocket = zmq.NewRep(ctx)
	k.shellSocket = zmq.NewRouter(ctx)
	k.controlSocket = zmq.NewRouter(ctx)
	k.iopubSocket = zmq.NewPub(ctx)
	k.stdinSocket = zmq.NewRouter(ctx)

	if err = k.hbSocket.Listen(k.connInfo.Endpoint(k.connInfo.HBPort)); err != nil {
		return fmt.Errorf("listen heartbeat: %w", err)
	}
	if err = k.shellSocket.Listen(k.connInfo.Endpoint(k.connInfo.ShellPort)); err != nil {
		return fmt.Errorf("listen shell: %w", err)
	}
	if err = k.controlSocket.Listen(k.connInfo.Endpoint(k.connInfo.ControlPort)); err != nil {
		return fmt.Errorf("listen control: %w", err)
	}
	if err = k.iopubSocket.Listen(k.connInfo.Endpoint(k.connInfo.IOPubPort)); err != nil {
		return fmt.Errorf("listen iopub: %w", err)
	}
	if err = k.stdinSocket.Listen(k.connInfo.Endpoint(k.connInfo.StdinPort)); err != nil {
		return fmt.Errorf("listen stdin: %w", err)
	}

	// Start Arrow HTTP server
	if k.spool != nil {
		as, err := NewArrowServer(k.spool)
		if err != nil {
			log.Printf("Warning: failed to start Arrow HTTP server: %v", err)
		} else {
			k.arrowServer = as
			// Wire explorer HTTP endpoints to IDE service
			as.SetExplorerHandler(newExplorerBridge(k.ide))
		}
	}

	log.Printf("Hugr GraphQL Kernel started on %s://%s", k.connInfo.Transport, k.connInfo.IP)

	go k.heartbeatLoop(ctx)
	go k.shellLoop(ctx)
	go k.controlLoop(ctx)

	<-ctx.Done()

	return k.close()
}

func (k *Kernel) close() error {
	if k.arrowServer != nil {
		k.arrowServer.Close()
	}
	if k.spool != nil {
		if err := k.spool.Destroy(); err != nil {
			log.Printf("spool destroy error: %v", err)
		}
	}
	k.hbSocket.Close()
	k.shellSocket.Close()
	k.controlSocket.Close()
	k.iopubSocket.Close()
	k.stdinSocket.Close()
	return nil
}

func (k *Kernel) heartbeatLoop(ctx context.Context) {
	for {
		msg, err := k.hbSocket.Recv()
		if err != nil {
			select {
			case <-ctx.Done():
			default:
				log.Printf("heartbeat recv error: %v", err)
			}
			return
		}
		if err := k.hbSocket.Send(msg); err != nil {
			log.Printf("heartbeat send error: %v", err)
			return
		}
	}
}

func (k *Kernel) shellLoop(ctx context.Context) {
	for {
		zmqMsg, err := k.shellSocket.Recv()
		if err != nil {
			select {
			case <-ctx.Done():
			default:
				log.Printf("shell recv error: %v", err)
			}
			return
		}

		if !VerifySignature(k.key, zmqMsg.Frames) {
			log.Printf("shell: invalid signature, dropping message")
			continue
		}

		msg, err := Deserialize(zmqMsg.Frames)
		if err != nil {
			log.Printf("shell deserialize error: %v", err)
			continue
		}

		k.handleShellMessage(ctx, msg)
	}
}

func (k *Kernel) controlLoop(ctx context.Context) {
	for {
		zmqMsg, err := k.controlSocket.Recv()
		if err != nil {
			select {
			case <-ctx.Done():
			default:
				log.Printf("control recv error: %v", err)
			}
			return
		}

		if !VerifySignature(k.key, zmqMsg.Frames) {
			log.Printf("control: invalid signature, dropping message")
			continue
		}

		msg, err := Deserialize(zmqMsg.Frames)
		if err != nil {
			log.Printf("control deserialize error: %v", err)
			continue
		}

		if msg.Header.MsgType == "shutdown_request" {
			k.handleShutdownRequest(msg)
		}
	}
}

func (k *Kernel) sendMessage(socket zmq.Socket, msg *Message) error {
	frames, err := msg.Serialize(k.key)
	if err != nil {
		return fmt.Errorf("serialize: %w", err)
	}
	zmqMsg := zmq.NewMsgFrom(frames...)
	return socket.Send(zmqMsg)
}

// sendIOPub sends a message on the iopub socket with mutex protection.
func (k *Kernel) sendIOPub(msg *Message) error {
	k.iopubMu.Lock()
	defer k.iopubMu.Unlock()
	return k.sendMessage(k.iopubSocket, msg)
}

func (k *Kernel) publishStatus(parent *Message, status string) {
	msg := NewMessage(parent, "status")
	msg.Content["execution_state"] = status
	if err := k.sendIOPub(msg); err != nil {
		log.Printf("publish status error: %v", err)
	}
}
