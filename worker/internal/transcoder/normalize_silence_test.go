package transcoder

import "testing"

func TestSilentLoudnessSkipsInvalidFilter(t *testing.T) {
	for _, raw := range []string{`{"input_i":"-inf","input_lra":"0","input_tp":"-inf","input_thresh":"-70"}`, `{"input_i":"-80","input_lra":"0","input_tp":"-75","input_thresh":"-70"}`} {
		s, e := parseLoudnessStats(raw, nil)
		if e != nil || s != nil {
			t.Fatalf("silence should skip: %+v %v", s, e)
		}
	}
	if got := BuildLoudnormFilter(nil, -16, -1.5, 10); got != "" {
		t.Fatal(got)
	}
	if _, err := parseLoudnessStats("no stats", nil); err == nil {
		t.Fatal("missing statistics accepted")
	}
}
