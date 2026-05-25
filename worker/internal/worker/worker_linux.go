//go:build linux

package worker

// platformRegistrationMeta returns platform-specific metadata for the worker startup log.
func platformRegistrationMeta() map[string]string {
	return nil
}
