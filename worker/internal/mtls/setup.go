package mtls

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Sentinel errors returned by CheckCertValidity so callers can differentiate
// an expired cert (needs renewal) from a not-yet-valid one (clock skew or
// freshly-issued cert that hasn't started). Both are fatal for the worker —
// it cannot authenticate against the server with an invalid cert.
var (
	ErrCertExpired     = errors.New("mTLS client certificate expired")
	ErrCertNotYetValid = errors.New("mTLS client certificate not yet valid")
)

const (
	certDir  = "cert"
	keyFile  = "client.key"
	certFile = "client.crt"
	csrFile  = "client.csr"
)

func keyPath() string  { return filepath.Join(certDir, keyFile) }
func certPath() string { return filepath.Join(certDir, certFile) }
func csrPath() string  { return filepath.Join(certDir, csrFile) }

// CertFilesExist returns true if both client.key and client.crt exist in cert/.
func CertFilesExist() bool {
	_, errKey := os.Stat(keyPath())
	_, errCrt := os.Stat(certPath())
	return errKey == nil && errCrt == nil
}

// LoadTLSConfig loads the client certificate and key from cert/ and returns
// a tls.Config suitable for mTLS connections.
func LoadTLSConfig() (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certPath(), keyPath())
	if err != nil {
		return nil, fmt.Errorf("load client certificate: %w", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
	}, nil
}

// LoadTLSConfigWithCert loads the client cert/key AND returns the parsed leaf
// *x509.Certificate so the caller can do per-request NotBefore/NotAfter checks
// without re-reading the file every time.
//
// The returned cert is the immutable, in-memory parsed copy — editing
// cert/client.crt on disk after startup does not affect it.
func LoadTLSConfigWithCert() (*tls.Config, *x509.Certificate, error) {
	cert, err := tls.LoadX509KeyPair(certPath(), keyPath())
	if err != nil {
		return nil, nil, fmt.Errorf("load client certificate: %w", err)
	}
	if len(cert.Certificate) == 0 {
		return nil, nil, fmt.Errorf("client certificate is empty")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, nil, fmt.Errorf("parse leaf certificate: %w", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
	}, leaf, nil
}

// CheckCertValidity returns ErrCertNotYetValid if now is before NotBefore,
// or ErrCertExpired if now is after NotAfter. Returns nil if the cert is
// currently within its validity window.
//
// This is the cheap (~nanoseconds) pre-flight check the API client runs
// before every outbound request so an expired cert fails fast with a clean
// shutdown instead of an opaque TLS handshake error.
func CheckCertValidity(cert *x509.Certificate) error {
	now := time.Now()
	if now.Before(cert.NotBefore) {
		return fmt.Errorf("%w (NotBefore=%s)", ErrCertNotYetValid, cert.NotBefore.Format(time.RFC3339))
	}
	if now.After(cert.NotAfter) {
		return fmt.Errorf("%w (NotAfter=%s)", ErrCertExpired, cert.NotAfter.Format(time.RFC3339))
	}
	return nil
}

// Setup runs the interactive mTLS certificate setup flow:
//  1. Creates cert/ directory
//  2. Generates P-256 private key (if client.key is missing)
//  3. Generates CSR, saves it, and prints it to console
//  4. Prompts user to paste the signed certificate (or place the file manually)
func Setup(reader *bufio.Reader) error {
	// Create cert directory
	if err := os.MkdirAll(certDir, 0700); err != nil {
		return fmt.Errorf("create cert directory: %w", err)
	}

	// Step 1: Generate private key if missing
	if _, err := os.Stat(keyPath()); os.IsNotExist(err) {
		fmt.Println("Generating P-256 (ECC) private key...")
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return fmt.Errorf("generate private key: %w", err)
		}

		keyDER, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return fmt.Errorf("marshal private key: %w", err)
		}

		keyPEM := pem.EncodeToMemory(&pem.Block{
			Type:  "EC PRIVATE KEY",
			Bytes: keyDER,
		})

		if err := os.WriteFile(keyPath(), keyPEM, 0600); err != nil {
			return fmt.Errorf("write private key: %w", err)
		}
		fmt.Printf("  Private key saved to %s\n", keyPath())
	} else {
		fmt.Printf("  Private key exists at %s\n", keyPath())
	}

	// Step 2: Load key and generate CSR
	keyPEM, err := os.ReadFile(keyPath())
	if err != nil {
		return fmt.Errorf("read private key: %w", err)
	}
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return fmt.Errorf("failed to decode private key PEM")
	}

	var privKey *ecdsa.PrivateKey
	switch block.Type {
	case "EC PRIVATE KEY":
		privKey, err = x509.ParseECPrivateKey(block.Bytes)
	case "PRIVATE KEY":
		parsed, parseErr := x509.ParsePKCS8PrivateKey(block.Bytes)
		if parseErr != nil {
			return fmt.Errorf("parse PKCS8 private key: %w", parseErr)
		}
		var ok bool
		privKey, ok = parsed.(*ecdsa.PrivateKey)
		if !ok {
			return fmt.Errorf("PKCS8 key is not ECDSA")
		}
	default:
		return fmt.Errorf("unsupported private key type: %s", block.Type)
	}
	if err != nil {
		return fmt.Errorf("parse private key: %w", err)
	}

	csrTemplate := &x509.CertificateRequest{
		Subject: pkix.Name{
			CommonName: "videosite-worker",
		},
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, csrTemplate, privKey)
	if err != nil {
		return fmt.Errorf("create CSR: %w", err)
	}
	csrPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE REQUEST",
		Bytes: csrDER,
	})

	if err := os.WriteFile(csrPath(), csrPEM, 0644); err != nil {
		return fmt.Errorf("write CSR: %w", err)
	}

	fmt.Println()
	fmt.Println("========== Certificate Signing Request (CSR) ==========")
	fmt.Print(string(csrPEM))
	fmt.Println("=======================================================")
	fmt.Printf("CSR saved to %s\n", csrPath())
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  1. Go to Cloudflare Dashboard -> SSL/TLS -> Client Certificates")
	fmt.Println("  2. Click 'Create Certificate'")
	fmt.Println("  3. Choose 'Use my own private key and CSR'")
	fmt.Println("  4. Paste the CSR above")
	fmt.Println("  5. Create the certificate and copy the PEM")
	fmt.Println()
	fmt.Println("Then either:")
	fmt.Println("  (a) Paste the certificate PEM below, OR")
	fmt.Printf("  (b) Save it as %s and press Enter\n", certPath())
	fmt.Println()

	// Step 3: Get the signed certificate
	for {
		fmt.Print("> ")
		line, _ := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")

		// User pressed Enter without pasting — check if file was placed manually
		if line == "" {
			if _, err := os.Stat(certPath()); err == nil {
				fmt.Printf("  Found %s\n", certPath())
				break
			}
			fmt.Printf("  %s not found. Paste the PEM or place the file and press Enter.\n", certPath())
			continue
		}

		// User is pasting PEM content
		if strings.Contains(line, "-----BEGIN CERTIFICATE-----") {
			certLines := []string{line}
			for {
				nextLine, _ := reader.ReadString('\n')
				nextLine = strings.TrimRight(nextLine, "\r\n")
				certLines = append(certLines, nextLine)
				if strings.Contains(nextLine, "-----END CERTIFICATE-----") {
					break
				}
			}

			certPEMData := strings.Join(certLines, "\n") + "\n"

			// Validate the certificate
			certBlock, _ := pem.Decode([]byte(certPEMData))
			if certBlock == nil {
				fmt.Println("  Invalid PEM: no certificate block found. Try again.")
				continue
			}
			if _, err := x509.ParseCertificate(certBlock.Bytes); err != nil {
				fmt.Printf("  Invalid certificate: %s. Try again.\n", err)
				continue
			}

			if err := os.WriteFile(certPath(), []byte(certPEMData), 0644); err != nil {
				return fmt.Errorf("write certificate: %w", err)
			}
			fmt.Printf("  Certificate saved to %s\n", certPath())
			break
		}

		fmt.Println("  Expected PEM beginning with '-----BEGIN CERTIFICATE-----'. Try again.")
	}

	// Verify the key pair matches
	if _, err := tls.LoadX509KeyPair(certPath(), keyPath()); err != nil {
		return fmt.Errorf("certificate and key do not match: %w", err)
	}

	fmt.Println()
	fmt.Println("mTLS configured successfully!")
	return nil
}
