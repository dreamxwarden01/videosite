package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"videosite-worker/internal/api"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
	"videosite-worker/internal/mtls"
	"videosite-worker/internal/transcoder"
	"videosite-worker/internal/util"
	"videosite-worker/internal/worker"
)

func main() {
	// Set up structured logging
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	printPlatformBanner()

	// 0. Ensure the logs directory exists (persistent FFmpeg log files live here).
	if err := os.MkdirAll("logs", 0755); err != nil {
		fmt.Printf("%s WARNING: could not create logs directory: %s\n", util.Ts(), err)
	}

	// 1. Check for FFmpeg
	if err := transcoder.DetectFFmpeg(); err != nil {
		fmt.Printf("%s ERROR: %s\n", util.Ts(), err)
		fmt.Println("Please install FFmpeg and ensure it's in your PATH.")
		os.Exit(1)
	}
	fmt.Printf("%s FFmpeg detected\n", util.Ts())

	// 2. Load or create config
	cfg, err := config.Load()
	if err != nil {
		fmt.Printf("%s ERROR: Failed to load config: %s\n", util.Ts(), err)
		os.Exit(1)
	}

	if cfg == nil {
		// First run — prompt for setup
		cfg, err = config.RunFirstSetup()
		if err != nil {
			fmt.Printf("%s ERROR: Setup failed: %s\n", util.Ts(), err)
			os.Exit(1)
		}
	} else {
		fmt.Printf("%s Config loaded (site: %s)\n", util.Ts(), cfg.SiteHostname)
	}

	// 3. mTLS setup
	var tlsCfg *tls.Config
	tlsCfg, err = handleMTLS(cfg)
	if err != nil {
		fmt.Printf("%s ERROR: mTLS setup failed: %s\n", util.Ts(), err)
		os.Exit(1)
	}

	// 4. Initialize HTTP client (mTLS + proxy)
	api.Init(tlsCfg, cfg.UseSystemProxy)
	fmt.Println()

	// 5. Detect hardware encoders
	caps, err := hardware.DetectAndMerge()
	if err != nil {
		fmt.Printf("%s WARNING: Hardware detection error: %s\n", util.Ts(), err)
	}

	printHardwareInfo(caps)

	// 6. Create the worker
	w := worker.New()

	// 7. Handle OS interrupt signals — trigger graceful stop (same as "stop" command)
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\nInterrupt received — initiating graceful stop...")
		w.GracefulStop()
	}()

	// 8. Start the worker
	w.Run()
}

// handleMTLS checks the mTLS configuration and runs interactive setup if needed.
// Returns a *tls.Config for the HTTP client (nil if mTLS is disabled).
func handleMTLS(cfg *config.Config) (*tls.Config, error) {
	reader := bufio.NewReader(os.Stdin)

	needsPrompt := cfg.EnableMTLS == nil || (cfg.MTLSEnabled() && !mtls.CertFilesExist())

	if needsPrompt {
		fmt.Println()
		fmt.Print("Enable mTLS for API communication? (yes/no) [no]: ")
		answer, _ := reader.ReadString('\n')
		answer = strings.ToLower(strings.TrimSpace(strings.TrimRight(answer, "\r\n")))
		enabled := answer == "yes" || answer == "y"

		if err := cfg.SetMTLS(enabled); err != nil {
			return nil, fmt.Errorf("save mTLS config: %w", err)
		}

		if !enabled {
			fmt.Println("mTLS disabled")
			return nil, nil
		}

		fmt.Println()
		fmt.Println("=== mTLS Certificate Setup ===")
		if err := mtls.Setup(reader); err != nil {
			return nil, err
		}
	}

	if !cfg.MTLSEnabled() {
		return nil, nil
	}

	if !mtls.CertFilesExist() {
		return nil, fmt.Errorf("mTLS is enabled but cert/client.key or cert/client.crt is missing")
	}

	tlsCfg, err := mtls.LoadTLSConfig()
	if err != nil {
		return nil, err
	}
	fmt.Printf("%s mTLS: client certificate loaded\n", util.Ts())
	return tlsCfg, nil
}
