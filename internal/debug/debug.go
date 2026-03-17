// Package debug provides conditional debug logging controlled by HUGR_KERNEL_DEBUG env var.
package debug

import (
	"log"
	"os"
)

// Enabled is true when HUGR_KERNEL_DEBUG is set to a non-empty value.
var Enabled = os.Getenv("HUGR_KERNEL_DEBUG") != ""

// Printf logs a message only when debug mode is enabled.
func Printf(format string, args ...any) {
	if Enabled {
		log.Printf(format, args...)
	}
}
