package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"path/filepath"

	"github.com/google/uuid"
	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/kernel"
	"github.com/hugr-lab/hugr-kernel/internal/meta"
	"github.com/hugr-lab/hugr-kernel/internal/result"
	"github.com/hugr-lab/hugr-kernel/internal/schema"
	"github.com/hugr-lab/hugr-kernel/internal/session"
)

func main() {
	connectionFile := flag.String("connection-file", "", "Path to Jupyter connection file")
	logFile := flag.String("log-file", "", "Path to log file (default: stderr)")
	flag.Parse()

	// Log file: flag > env var > stderr
	logPath := *logFile
	if logPath == "" {
		logPath = os.Getenv("HUGR_KERNEL_LOG")
	}
	if logPath != "" {
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: cannot open log file %s: %v (logging to stderr)\n", logPath, err)
		} else {
			defer f.Close()
			log.SetOutput(f)
		}
	}

	if *connectionFile == "" {
		fmt.Fprintln(os.Stderr, "Usage: hugr-kernel --connection-file <path>")
		os.Exit(1)
	}

	// Parse connection file
	connInfo, err := parseConnectionFile(*connectionFile)
	if err != nil {
		log.Fatalf("Failed to parse connection file: %v", err)
	}

	// Create session
	sessionID := uuid.New().String()
	sess := session.NewSession(sessionID)

	// Create connection manager
	cm := connection.NewManager()

	// Pre-populate connections from environment
	loadConnectionsFromEnv(cm)

	// Create result spool
	sp, err := result.NewSpool(sessionID)
	if err != nil {
		log.Printf("Warning: failed to create spool: %v (Arrow file output disabled)", err)
	}

	// Create meta command registry
	startTime := time.Now()
	reg := meta.NewRegistry()
	meta.RegisterCommands(reg, sess, cm, startTime)

	// Load connections from config file
	loadConnectionsFromFile(cm)

	// Create schema client for IDE features
	sc := schema.NewClient()

	// Create kernel
	k := kernel.NewKernel(connInfo, sess, cm, sp, reg, sc)

	// Context cancelled on SIGINT, SIGTERM, or SIGHUP (VS Code may send SIGHUP on close).
	// The same context is passed to ZMQ sockets — cancellation unblocks Recv() calls.
	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	// Wrap with a manual cancel so the watchdog can also cancel the context.
	ctx, cancel := context.WithCancel(sigCtx)
	defer cancel()

	// Watchdog: exit if parent process dies (e.g., VS Code crashed or closed).
	// This prevents orphaned kernel processes holding ZMQ ports.
	ppid := os.Getppid()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
				if os.Getppid() != ppid {
					log.Println("Parent process exited, shutting down")
					cancel()
					return
				}
			}
		}
	}()

	// Start kernel
	log.Printf("Starting Hugr GraphQL Kernel (session: %s)", sessionID)
	if err := k.Start(ctx); err != nil {
		log.Fatalf("Kernel error: %v", err)
	}

	log.Println("Hugr GraphQL Kernel stopped")
}

func parseConnectionFile(path string) (*kernel.ConnectionInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read connection file: %w", err)
	}

	var info kernel.ConnectionInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, fmt.Errorf("parse connection file: %w", err)
	}

	return &info, nil
}

// loadConnectionsFromEnv pre-populates connections from environment variables.
func loadConnectionsFromEnv(cm *connection.Manager) {
	if env := os.Getenv("HUGR_CONNECTIONS"); env != "" {
		var conns []struct {
			Name    string `json:"name"`
			URL     string `json:"url"`
			APIKey  string `json:"api_key,omitempty"`
			Token   string `json:"token,omitempty"`
			Role    string `json:"role,omitempty"`
		}
		if err := json.Unmarshal([]byte(env), &conns); err != nil {
			log.Printf("Warning: failed to parse HUGR_CONNECTIONS: %v", err)
		} else {
			for _, c := range conns {
				cm.Add(c.Name, c.URL)
			}
		}
	}
}

// loadConnectionsFromFile loads connections from ~/.hugr/connections.json.
func loadConnectionsFromFile(cm *connection.Manager) {
	// Check env override first
	configPath := os.Getenv("HUGR_CONFIG_PATH")
	if configPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		configPath = filepath.Join(home, ".hugr", "connections.json")
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return // file doesn't exist, no problem
	}

	var cfg struct {
		Default     string `json:"default"`
		Connections []struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"connections"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Printf("Warning: failed to parse %s: %v", configPath, err)
		return
	}

	for _, c := range cfg.Connections {
		if c.Name != "" && c.URL != "" {
			// Don't override env connections
			if _, err := cm.Get(c.Name); err != nil {
				cm.Add(c.Name, c.URL)
			}
		}
	}

	// Set default connection if specified in config
	if cfg.Default != "" {
		if err := cm.SetDefault(cfg.Default); err == nil {
			log.Printf("Default connection set to %q from config", cfg.Default)
		}
	}
	log.Printf("Loaded %d connections from %s", len(cfg.Connections), configPath)
}
