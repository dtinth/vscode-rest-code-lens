import axios from 'axios'
import { setTimeout } from 'timers'
import * as vscode from 'vscode'

type Provider = {
  pattern: string
  url: string
  flags?: string
}

function ensureGlobal(flags: string) {
  return flags + (flags.includes('g') ? '' : 'g')
}

type RestLensMatch = {
  range: vscode.Range
  providerId: string
  requestUrl: string
}

type RestLensMatchCache = {
  lastVersion: number
  matches: RestLensMatch[]
}

type RestLensRequestCache = {
  command: vscode.Command
  expires?: number
}

interface RestCodeLens extends vscode.CodeLens {
  match: RestLensMatch
}

class RestCodeLensProvider implements vscode.CodeLensProvider<RestCodeLens> {
  private emitter = new vscode.EventEmitter<void>()
  private matchCache = createMatchCache()
  private requestCache = createRequestCache()
  private gonnaUpdate = false

  onDidChangeCodeLenses = this.emitter.event

  provideCodeLenses(document: vscode.TextDocument) {
    let matchCache = this.matchCache.get(document)

    if (!matchCache) {
      matchCache = { lastVersion: -1, matches: [] }
      this.matchCache.set(document, matchCache)
    }

    if (document.version > matchCache.lastVersion) {
      matchCache.lastVersion = document.version
      matchCache.matches = []

      const providers = vscode.workspace
        .getConfiguration('restLens', document)
        .get<{ [key: string]: Provider }>('providers', {})

      for (const [providerId, provider] of Object.entries(providers)) {
        try {
          if (provider) {
            const pattern = String(provider.pattern)
            const flags = ensureGlobal(provider.flags || '')
            const url = String(provider.url)
            const documentMatches = document
              .getText()
              .matchAll(new RegExp(pattern, flags))
            for (const match of documentMatches) {
              if (match.index == null) continue
              if (match.input == null) continue
              const range = new vscode.Range(
                document.positionAt(match.index),
                document.positionAt(match.index + match.input.length),
              )
              const captureGroups = match.slice()
              const requestUrl =
                url +
                (url.includes('?') ? '&' : '?') +
                captureGroups
                  .map((g) => 'm[]=' + encodeURIComponent(g))
                  .join('&')
              matchCache.matches.push({ range, requestUrl, providerId })
            }
          }
        } catch (error) {
          console.error(providerId, error)
        }
      }
    }

    return matchCache.matches.map((m) => this.getCodeLens(m, false))
  }

  resolveCodeLens(codeLens: RestCodeLens): RestCodeLens {
    return this.getCodeLens(codeLens.match, true)
  }

  private getCodeLens(
    matchItem: RestLensMatch,
    resolveImmediately: boolean,
  ): RestCodeLens {
    const key = matchItem.providerId + ':' + matchItem.requestUrl
    let lens = this.requestCache.get(key)
    if (!lens || (lens.expires && Date.now() > lens.expires)) {
      if (!resolveImmediately) {
        return {
          isResolved: false,
          match: matchItem,
          range: matchItem.range,
        }
      }
      lens = {
        command: {
          title: `(loading ${matchItem.providerId}…)`,
          command: 'restLens.pending',
          arguments: [matchItem.providerId, matchItem.requestUrl],
        },
      }
      this.requestCache.set(key, lens)
      ;(async () => {
        try {
          const { data } = await axios.get(matchItem.requestUrl, {
            timeout: 15000,
          })
          const title =
            data.title || `${matchItem.providerId} did not provide a title`
          const command = data.command || 'restLens.open'
          const args = Array.isArray(data.arguments)
            ? data.arguments
            : [data.url]
          lens.command = { title, command, arguments: args }
        } catch (error) {
          lens.command = {
            title: `[${matchItem.providerId}] ${error}`,
            command: 'restLens.error',
            arguments: [
              matchItem.providerId,
              matchItem.requestUrl,
              String(error),
            ],
          }
        } finally {
          if (!this.gonnaUpdate) {
            this.gonnaUpdate = true
            setTimeout(() => {
              this.gonnaUpdate = false
              this.emitter.fire()
            }, 100)
          }
        }
      })()
    }
    return {
      isResolved: true,
      command: lens.command,
      range: matchItem.range,
      match: matchItem,
    }
  }

  clearResponseCache() {
    this.matchCache = createMatchCache()
    this.requestCache = createRequestCache()
    this.emitter.fire()
    vscode.window.showInformationMessage('Response cache has been cleared')
  }
}

function createRequestCache() {
  return new Map<string, RestLensRequestCache>()
}

function createMatchCache() {
  return new WeakMap<vscode.TextDocument, RestLensMatchCache>()
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new RestCodeLensProvider()
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: 'file' },
        { scheme: 'git' },
        { scheme: 'vsls' },
        { scheme: 'untitled' },
      ],
      provider,
    ),
    vscode.commands.registerCommand(
      'restLens.pending',
      (providerId, requestUrl) => {
        vscode.window
          .showInformationMessage(
            `REST lens is loading code lens for ${providerId}`,
            'Copy URL',
            'Open URL',
          )
          .then((r) => {
            if (r === 'Open URL') {
              vscode.env.openExternal(vscode.Uri.parse(requestUrl))
            }
            if (r === 'Copy URL') {
              vscode.env.clipboard.writeText(requestUrl)
            }
          })
      },
    ),
    vscode.commands.registerCommand(
      'restLens.error',
      (providerId, requestUrl, errorMessage) => {
        vscode.window
          .showInformationMessage(
            `REST lens had trouble loading code lens for ${providerId}: ${errorMessage}`,
            'Copy URL',
            'Open URL',
          )
          .then((r) => {
            if (r === 'Open URL') {
              vscode.env.openExternal(vscode.Uri.parse(requestUrl))
            }
            if (r === 'Copy URL') {
              vscode.env.clipboard.writeText(requestUrl)
            }
          })
      },
    ),
    vscode.commands.registerCommand('restLens.open', (url) => {
      vscode.env.openExternal(vscode.Uri.parse(url))
    }),
    vscode.commands.registerCommand('restLens.clearResponseCache', () => {
      provider.clearResponseCache()
    }),
  )
}

// this method is called when your extension is deactivated
export function deactivate() {}
