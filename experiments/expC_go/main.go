// Experiment C (Go): real MCP client + server over stdio on the official Go SDK.
// Run: go run .   (the binary re-executes itself in -server mode)
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type EchoIn struct {
	Text string `json:"text" jsonschema:"text to echo back"`
}

type EchoOut struct {
	Echo string `json:"echo"`
	At   string `json:"at"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-server" {
		runServer()
		return
	}
	runClient()
}

func runServer() {
	server := mcp.NewServer(&mcp.Implementation{Name: "go-echo", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "echo", Description: "echo text back"},
		func(ctx context.Context, req *mcp.CallToolRequest, in EchoIn) (*mcp.CallToolResult, EchoOut, error) {
			return nil, EchoOut{Echo: in.Text, At: time.Now().UTC().Format(time.RFC3339Nano)}, nil
		})
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

func runClient() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := mcp.NewClient(&mcp.Implementation{Name: "go-client", Version: "1.0.0"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{
		Command: exec.Command(os.Args[0], "-server"),
	}, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer session.Close()

	initJSON, _ := json.MarshalIndent(session.InitializeResult(), "", "  ")
	fmt.Println("=== initialize result (negotiated) ===")
	fmt.Println(string(initJSON))

	tools, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("=== tools/list ===")
	for _, t := range tools.Tools {
		fmt.Printf("  %s: %s\n", t.Name, t.Description)
	}

	res, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "echo",
		Arguments: map[string]any{"text": "hello from go"},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("=== tools/call echo ===")
	fmt.Printf("  isError=%v\n", res.IsError)
	for _, c := range res.Content {
		if txt, ok := c.(*mcp.TextContent); ok {
			fmt.Printf("  text=%s\n", txt.Text)
		}
	}
}
