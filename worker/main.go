package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"videosite-worker/internal/api"
	"videosite-worker/internal/auth"
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

	// 3. mTLS setup. Returns the parsed leaf certificate alongside the
	// tls.Config so the API client can do per-request NotBefore/NotAfter
	// checks without re-reading the cert file.
	tlsCfg, leafCert, err := handleMTLS(cfg)
	if err != nil {
		fmt.Printf("%s ERROR: mTLS setup failed: %s\n", util.Ts(), err)
		os.Exit(1)
	}

	// 4. Initialize HTTP client (mTLS + live system-proxy lookup).
	api.Init(tlsCfg, leafCert, cfg.UseSystemProxy)
	fmt.Println()

	// 4b. Obtain the first bearer token. All authenticated API calls go
	// through the shared Session, which will transparently re-auth on any
	// future 401. Bad credentials here → exit 2; transient errors → retry.
	if err := bootstrapSession(); err != nil {
		if errors.Is(err, api.ErrAuthFailed) {
			fmt.Printf("%s ERROR: authentication rejected — check keyId/keySecret in config.json\n", util.Ts())
			os.Exit(2)
		}
		fmt.Printf("%s ERROR: could not authenticate to site after retries: %s\n", util.Ts(), err)
		os.Exit(1)
	}
	fmt.Printf("%s Authenticated (bearer issued)\n", util.Ts())

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

// bootstrapSession performs the initial /api/worker/auth exchange and hands
// the populated Session to the API client. Retries with a simple linear
// backoff on transient errors; 401 is fatal (bad config).
func bootstrapSession() error {
	session := auth.NewSession()
	api.SetSession(session)

	backoff := []time.Duration{0, 2 * time.Second, 5 * time.Second, 10 * time.Second, 20 * time.Second}
	var lastErr error
	for i, delay := range backoff {
		if delay > 0 {
			time.Sleep(delay)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := session.Refresh(ctx, api.Authenticate)
		cancel()
		if err == nil {
			return nil
		}
		if errors.Is(err, api.ErrAuthFailed) {
			return err // fatal — no point retrying
		}
		lastErr = err
		if i < len(backoff)-1 {
			fmt.Printf("%s Auth attempt %d/%d failed: %s — retrying\n", util.Ts(), i+1, len(backoff), err)
		}
	}
	return fmt.Errorf("auth failed after %d attempts: %w", len(backoff), lastErr)
}

// handleMTLS checks the mTLS configuration and runs interactive setup if needed.
// Returns the *tls.Config and the parsed leaf *x509.Certificate used for
// per-request NotBefore/NotAfter pre-flight checks. Both are nil when mTLS
// is disabled (the cert check is then a no-op).
//
// An expired / not-yet-valid cert at startup is treated as fatal here so the
// user sees the exact reason immediately, rather than watching requests fail
// with opaque handshake errors.
func handleMTLS(cfg *config.Config) (*tls.Config, *x509.Certificate, error) {
	reader := bufio.NewReader(os.Stdin)

	needsPrompt := cfg.EnableMTLS == nil || (cfg.MTLSEnabled() && !mtls.CertFilesExist())

	if needsPrompt {
		fmt.Println()
		fmt.Print("Enable mTLS for API communication? (yes/no) [no]: ")
		answer, _ := reader.ReadString('\n')
		answer = strings.ToLower(strings.TrimSpace(strings.TrimRight(answer, "\r\n")))
		enabled := answer == "yes" || answer == "y"

		if err := cfg.SetMTLS(enabled); err != nil {
			return nil, nil, fmt.Errorf("save mTLS config: %w", err)
		}

		if !enabled {
			fmt.Println("mTLS disabled")
			return nil, nil, nil
		}

		fmt.Println()
		fmt.Println("=== mTLS Certificate Setup ===")
		if err := mtls.Setup(reader); err != nil {
			return nil, nil, err
		}
	}

	if !cfg.MTLSEnabled() {
		return nil, nil, nil
	}

	if !mtls.CertFilesExist() {
		return nil, nil, fmt.Errorf("mTLS is enabled but cert/client.key or cert/client.crt is missing")
	}

	tlsCfg, leafCert, err := mtls.LoadTLSConfigWithCert()
	if err != nil {
		return nil, nil, err
	}
	if err := mtls.CheckCertValidity(leafCert); err != nil {
		return nil, nil, fmt.Errorf("client certificate not usable: %w", err)
	}
	fmt.Printf("%s mTLS: client certificate loaded (valid until %s)\n",
		util.Ts(), leafCert.NotAfter.Format("2006-01-02"))
	return tlsCfg, leafCert, nil
}
