package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestUploadURLHTTPStatusIsCheckedBeforeJSONSuccess(t *testing.T) {
	for _, status := range []int{201, 204, 400, 403, 404, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				json.NewEncoder(w).Encode(map[string]any{"error": "synthetic", "urls": map[string]string{"poster.jpg": "https://storage.example.invalid/poster.jpg"}})
			})
			urls, err := GetUploadURLs(context.Background(), "Job000000007", []string{"poster.jpg"})
			if err == nil || urls != nil {
				t.Fatal("HTTP error decoded as successful URL map")
			}
			if status == 404 && !errors.Is(err, ErrJobNotFound) {
				t.Fatalf("404 lost terminal meaning: %v", err)
			}
		})
	}
}
func TestUploadURLSuccessMustContainEveryRequestedNonemptyURL(t *testing.T) {
	for i, body := range []any{nil, map[string]any{}, map[string]any{"urls": nil}, map[string]any{"urls": map[string]string{}}, map[string]any{"urls": map[string]string{"poster.jpg": ""}}, map[string]any{"urls": map[string]string{"poster.jpg": "  "}}, map[string]any{"urls": map[string]string{"poster.jpg": "https://storage.example.invalid/poster.jpg"}}, map[string]any{"urls": map[string]any{"poster.jpg": 42, "media.m4s": "https://storage.example.invalid/media.m4s"}}} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(body)
			})
			if urls, err := GetUploadURLs(context.Background(), "Job000000007", []string{"poster.jpg", "media.m4s"}); err == nil || urls != nil {
				t.Fatalf("invalid map was accepted: %#v", urls)
			}
		})
	}
}
