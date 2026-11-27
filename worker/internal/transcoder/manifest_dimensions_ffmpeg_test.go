package transcoder

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// Explicitly enabled in media acceptance runs. Pure init/manifest regressions
// still run on the Go-only image builder, which has no FFmpeg installation.
func TestActualOutputDimensionsFFmpeg(t *testing.T) {
	if os.Getenv("VIDEOSITE_FFMPEG_TESTS") != "1" {
		t.Skip("set VIDEOSITE_FFMPEG_TESTS=1 for real-media acceptance")
	}
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name                     string
		srcW, srcH, wantW, wantH int
		copyVideo, remuxFlag     bool
	}{
		{"remux722", 1280, 722, 1280, 722, true, true},
		{"fallbackToTranscode722", 1280, 722, 1276, 720, false, true},
		{"transcodeWide564", 1280, 564, 1280, 564, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			dir := t.TempDir()
			source := filepath.Join(dir, "source.mp4")
			args := []string{"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", fmt.Sprintf("color=c=blue:s=%dx%d:r=30", tc.srcW, tc.srcH), "-t", "4", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0", source}
			if out, err := exec.CommandContext(ctx, "ffmpeg", args...).CombinedOutput(); err != nil {
				t.Fatalf("source: %v\n%s", err, out)
			}
			profile := FilteredProfile{OutputProfile: config.OutputProfile{Name: "720p", Width: 1280, Height: 720, Codec: "h264", Profile: "high", Preset: "ultrafast", VideoBitrateKbps: 1200}, CanRemux: tc.remuxFlag, Plan: NewSegmentPlan(30, 1, 1, 2)}
			profile.OutW, profile.OutH = ActualOutputDims(tc.srcW, tc.srcH, 1280, 720)
			output := filepath.Join(dir, "video", "720p")
			var progress <-chan int
			var result <-chan error
			if tc.copyVideo {
				progress, result = RemuxVideo(ctx, source, output, profile.OutputProfile, profile.Plan, 4, "")
			} else {
				progress, result = TranscodeVideo(ctx, source, output, profile.OutputProfile, profile.Plan, config.Encoder{EncoderType: hardware.EncoderSW}, 4, true, "", profile.OutW, profile.OutH, 30)
			}
			for range progress {
			}
			if err := <-result; err != nil {
				t.Fatal(err)
			}
			init := filepath.Join(output, "init.mp4")
			v, err := VariantFromInit(profile, init)
			if err != nil {
				t.Fatal(err)
			}
			segments, err := filepath.Glob(filepath.Join(output, "segment_*.m4s"))
			if err != nil || len(segments) == 0 {
				t.Fatalf("segments: %v %v", segments, err)
			}
			joined := filepath.Join(dir, "completed.mp4")
			f, err := os.Create(joined)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range append([]string{init}, segments...) {
				data, e := os.ReadFile(path)
				if e != nil {
					f.Close()
					t.Fatal(e)
				}
				if _, e = f.Write(data); e != nil {
					f.Close()
					t.Fatal(e)
				}
			}
			if err = f.Close(); err != nil {
				t.Fatal(err)
			}
			raw, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", joined).Output()
			if err != nil {
				t.Fatal(err)
			}
			var measured struct{ Streams []struct{ Width, Height int } }
			if err := json.Unmarshal(raw, &measured); err != nil {
				t.Fatal(err)
			}
			if len(measured.Streams) != 1 {
				t.Fatalf("streams: %s", raw)
			}
			actual := measured.Streams[0]
			if actual.Width != tc.wantW || actual.Height != tc.wantH {
				t.Fatalf("scaling changed: %+v expected %dx%d", actual, tc.wantW, tc.wantH)
			}
			if v.Width != actual.Width || v.Height != actual.Height {
				t.Fatalf("init metadata %+v disagrees with ffprobe %+v", v, actual)
			}
			if err := RewritePlaylistHMAC(filepath.Join(output, "playlist.m3u8")); err != nil {
				t.Fatal(err)
			}
			assertDimensionManifests(t, dir, v, false, 4, actual.Width, actual.Height)
			t.Logf("actual media and both manifests: %dx%d", actual.Width, actual.Height)
		})
	}
}
