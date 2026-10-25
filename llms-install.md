# Installing Recued for an AI agent

These steps are for an AI agent, such as Cline, setting up Recued's MCP
server for its user. Recued is a server the user runs on their own
computer. You connect to it over MCP. First it must be installed and
paired, with an MCP door open for you.

Three steps need the user. They pair a browser, choose what the door may
show, and copy its secret key. Ask them at those points. Never make up a
key, and never ask for the 24-word recovery key.

## 1. Install the server

Linux and macOS:

```sh
curl -fsSL https://recued.com/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://recued.com/install.ps1 | iex
```

The script checks the signed binary and puts `recued` on the PATH. It also
starts the server when the user logs in. On headless Linux it needs `sudo`.

Check that the server is up:

```sh
curl --fail http://127.0.0.1:7717/health
```

## 2. Pair a browser (the user does this)

Run `recued pair` on the server computer. It prints a pairing code, the
server's addresses, and a pairing link. Ask the user to open
https://app.recued.com/pair, or the webclient address it prints. There
they type in the server address and the code. On the first pair they make
or type in a 24-word recovery key. Tell them to keep it offline, away from
the server.

The code works once, for 15 minutes. If it runs out, run `recued pair`
again.

## 3. Open an MCP door (the user does this)

In the web app, the user opens **Contracts** and makes an agreement for
you. That is the MCP door. They switch on the tools you may use under
**AI tools**, at the top of the agreement's list. Under each tool are the
other switches it needs, and they can switch those on right there. The
**Connect** tab shows the server's MCP address, which ends in `/mcp`, and
the door's secret key, once. Ask the user to paste both to you.

## 4. Add the server to Cline

Open **MCP Servers**, then **Configure MCP Servers**, and add:

```json
{
  "mcpServers": {
    "recued": {
      "type": "streamableHttp",
      "url": "<the MCP address from the Connect tab>",
      "headers": {
        "Authorization": "Bearer <the door's secret key>"
      }
    }
  }
}
```

Keep `"type": "streamableHttp"`. Without it, Cline uses the older SSE
transport. Keep the key in this file only. Do not print it back to the user.

## 5. Check it works

Recued should now list its tools. Two of them are always there, because
they are Recued's own: `recued_actionStatus` and `recued_stopRecipe`. If
those are the only two, the door shows no tools yet. Ask the user to switch
some on under **AI tools** on the agreement's page. If a tool they switched
on does not appear, the agreement may be older than Recued 26.10.24.
Its key keeps the tools it was made with, so ask the user to make a new
agreement. If Cline cannot connect and says the server requires
authorization, the key is wrong.

By default, anything that writes or deletes waits for the user's yes. A
call like that answers that it is queued for approval, with an
`action_ref`. Do not call the tool again. Tell the user to approve it from
the bell at the top of the Recued app. When they say they have answered,
check once with `recued_actionStatus`. Once the action has run, that answer
includes its result, such as a new note's id.
