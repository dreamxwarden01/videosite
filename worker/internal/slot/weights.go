package slot

// remap linearly projects `raw` from the [fromLo, fromHi] range onto the
// [toLo, toHi] range, clamping to [toLo, toHi] on the outside. All args are
// integers since the caller (runTranscode audio band remapping) works
// entirely in 0–100 space.
//
// Example: remap(15, 10, 100, 5, 50) = 5 + (15-10)*(50-5)/(100-10) = 7.
//
// Used by runTranscode to implement the audio progress band table (5%, 45%,
// 50% slices of the bar) without spreading the same fiddly arithmetic across
// three closures.
func remap(raw, fromLo, fromHi, toLo, toHi int) int {
	if fromHi <= fromLo {
		return toLo
	}
	if raw <= fromLo {
		return toLo
	}
	if raw >= fromHi {
		return toHi
	}
	return toLo + (raw-fromLo)*(toHi-toLo)/(fromHi-fromLo)
}
