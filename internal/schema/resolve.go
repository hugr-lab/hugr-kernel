package schema

import (
	"context"
	"fmt"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

// ResolveInputType walks an input path from a parent type's argument
// and returns the final *TypeInfo at the end of the path.
// inputPath should start with the argument name followed by nested field names.
// For example: ["filter", "name"] resolves the "filter" argument's type,
// then walks to the "name" field's type within that input object.
func ResolveInputType(ctx context.Context, client *Client, conn *connection.Connection, args []ArgInfo, inputPath []string) (*TypeInfo, error) {
	if len(inputPath) == 0 || len(args) == 0 {
		return nil, nil
	}

	// First element of inputPath is the argument name
	argName := inputPath[0]
	var currentTypeName string
	for _, arg := range args {
		if arg.Name == argName {
			currentTypeName = arg.Type.UnwrapName()
			break
		}
	}
	if currentTypeName == "" {
		return nil, nil
	}

	// Walk remaining path through input fields
	for _, fieldName := range inputPath[1:] {
		ti, err := client.GetType(ctx, conn, currentTypeName)
		if err != nil {
			return nil, fmt.Errorf("resolve input type %s: %w", currentTypeName, err)
		}
		if ti == nil {
			return nil, nil
		}
		found := false
		for _, f := range ti.InputFields {
			if f.Name == fieldName {
				currentTypeName = f.Type.UnwrapName()
				found = true
				break
			}
		}
		if !found {
			return nil, nil
		}
	}

	ti, err := client.GetType(ctx, conn, currentTypeName)
	if err != nil {
		return nil, fmt.Errorf("resolve input type %s: %w", currentTypeName, err)
	}
	return ti, nil
}
