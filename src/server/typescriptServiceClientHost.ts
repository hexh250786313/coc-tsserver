/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken, ConfigurationChangeEvent, Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity, DiagnosticTag, Disposable, disposeAll, ExtensionContext, languages, Range, Uri, workspace } from 'coc.nvim'
import { flatten } from '../utils/arrays'
import { PluginManager } from '../utils/plugins'
import { DiagnosticKind } from './features/diagnostics'
import FileConfigurationManager from './features/fileConfigurationManager'
import WorkspaceSymbolProvider from './features/workspaceSymbols'
import LanguageProvider from './languageProvider'
import * as Proto from './protocol'
import * as PConst from './protocol.const'
import { nodeRequestCancellerFactory } from './tsServer/cancellation'
import { NodeLogDirectoryProvider } from './tsServer/logDirectoryProvider'
import { ServiceProcessFactory } from './tsServer/serverProcess'
import TypeScriptServiceClient, { IClientServices } from './typescriptServiceClient'
import * as errorCodes from './utils/errorCodes'
import { DiagnosticLanguage, LanguageDescription } from './utils/languageDescription'
import * as typeConverters from './utils/typeConverters'
import TypingsStatus, { AtaProgressReporter } from './utils/typingsStatus'
import { formatDiagnostic } from './utils/formatDiagnostic'

// Style check diagnostics that can be reported as warnings
const styleCheckDiagnostics = new Set([
  ...errorCodes.variableDeclaredButNeverUsed,
  ...errorCodes.propertyDeclaretedButNeverUsed,
  ...errorCodes.allImportsAreUnused,
  ...errorCodes.unreachableCode,
  ...errorCodes.unusedLabel,
  ...errorCodes.fallThroughCaseInSwitch,
  ...errorCodes.notAllCodePathsReturnAValue,
])

export default class TypeScriptServiceClientHost implements Disposable {
  private readonly ataProgressReporter: AtaProgressReporter
  private readonly typingsStatus: TypingsStatus
  private readonly client: TypeScriptServiceClient
  private readonly languagePerId = new Map<string, LanguageProvider>()
  private readonly disposables: Disposable[] = []
  private readonly fileConfigurationManager: FileConfigurationManager
  private reportStyleCheckAsWarnings = true

  constructor(descriptions: LanguageDescription[], pluginManager: PluginManager, tscPath: string | null, context: ExtensionContext) {
    let timer: NodeJS.Timer
    const handleProjectChange = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        this.triggerAllDiagnostics()
      }, 1500)
    }

    const configFileWatcher = workspace.createFileSystemWatcher('**/[tj]sconfig.json')
    this.disposables.push(configFileWatcher)
    configFileWatcher.onDidCreate(this.reloadProjects, this, this.disposables)
    configFileWatcher.onDidDelete(this.reloadProjects, this, this.disposables)
    configFileWatcher.onDidChange(handleProjectChange, this, this.disposables)
    const packageFileWatcher = workspace.createFileSystemWatcher('**/package.json')
    packageFileWatcher.onDidCreate(this.reloadProjects, this, this.disposables)
    packageFileWatcher.onDidChange(handleProjectChange, this, this.disposables)
    const services: IClientServices = {
      pluginManager,
      logDirectoryProvider: new NodeLogDirectoryProvider(context),
      processFactory: new ServiceProcessFactory(),
      cancellerFactory: nodeRequestCancellerFactory
    }

    const allModeIds = this.getAllModeIds(descriptions, pluginManager)
    this.client = new TypeScriptServiceClient(context, allModeIds, services, tscPath)
    this.disposables.push(this.client)
    this.client.onDiagnosticsReceived(({ kind, resource, diagnostics }) => {
      this.diagnosticsReceived(kind, resource, diagnostics).catch(e => {
        console.error(e)
      })
    }, null, this.disposables)
    this.client.onResendModelsRequested(() => this.populateService(), null, this.disposables)

    // features
    this.disposables.push(languages.registerWorkspaceSymbolProvider(new WorkspaceSymbolProvider(this.client, allModeIds)))
    import('./features/updatePathOnRename').then(module => {
      this.disposables.push(module.register(this.client, this.fileConfigurationManager, uri => this.handles(uri)))
    })

    this.client.onConfigDiagnosticsReceived(diag => {
      let { body } = diag
      if (body) {
        let { configFile, diagnostics } = body
        let uri = Uri.file(configFile).toString()
        if (diagnostics.length == 0) {
          this.client.diagnosticsManager.configFileDiagnosticsReceived(uri, [])
        } else {
          let diagnosticList = diagnostics.map(diag => {
            let { text, code, start, end } = diag
            let range: Range
            if (!start || !end) {
              range = Range.create(0, 0, 0, 1)
            } else {
              range = Range.create(start.line - 1, start.offset - 1, end.line - 1, end.offset - 1)
            }
            let severity = this.getDiagnosticSeverity(diag)
            return Diagnostic.create(range, text, severity, code)
          })
          this.client.diagnosticsManager.configFileDiagnosticsReceived(uri, diagnosticList)
        }
      }
    }, null, this.disposables)
    this.typingsStatus = new TypingsStatus(this.client)
    this.ataProgressReporter = new AtaProgressReporter(this.client)
    this.fileConfigurationManager = new FileConfigurationManager(this.client)
    for (const description of descriptions) { // tslint:disable-line
      const manager = new LanguageProvider(
        this.client,
        this.fileConfigurationManager,
        description,
        this.typingsStatus
      )
      this.languagePerId.set(description.id, manager)
    }
    this.client.ensureServiceStarted()
    this.client.onReady(() => {
      const languageIds = new Set<string>()
      for (const plugin of pluginManager.plugins) {
        if (plugin.configNamespace && plugin.languages.length) {
          this.registerExtensionLanguageProvider({
            id: plugin.configNamespace,
            languageIds: Array.from(plugin.languages),
            diagnosticSource: 'ts-plugin',
            diagnosticLanguage: DiagnosticLanguage.TypeScript,
            diagnosticOwner: 'typescript',
            standardFileExtensions: [],
            isExternal: true
          })
        } else {
          for (const language of plugin.languages) {
            languageIds.add(language)
          }
        }
      }

      if (languageIds.size) {
        this.registerExtensionLanguageProvider({
          id: 'typescript-plugins',
          languageIds: Array.from(languageIds.values()),
          diagnosticSource: 'ts-plugin',
          diagnosticLanguage: DiagnosticLanguage.TypeScript,
          diagnosticOwner: 'typescript',
          standardFileExtensions: [],
          isExternal: true
        })
      }
    })
    this.client.onTsServerStarted(() => {
      this.triggerAllDiagnostics()
    })

    workspace.onDidChangeConfiguration(this.configurationChanged, this, this.disposables)
    this.configurationChanged()
  }

  private registerExtensionLanguageProvider(description: LanguageDescription) {
    const manager = new LanguageProvider(this.client, this.fileConfigurationManager, description, this.typingsStatus)
    this.languagePerId.set(description.id, manager)
  }

  public dispose(): void {
    disposeAll(this.disposables)
    for (let language of this.languagePerId.values()) {
      language.dispose()
    }
    this.languagePerId.clear()
    this.fileConfigurationManager.dispose()
    this.typingsStatus.dispose()
    this.ataProgressReporter.dispose()
  }

  public get serviceClient(): TypeScriptServiceClient {
    return this.client
  }

  public reloadProjects(): void {
    this.client.diagnosticsManager.reInitialize()
    this.client.execute('reloadProjects', null, CancellationToken.None)
    this.triggerAllDiagnostics()
  }

  // typescript or javascript
  public getProvider(languageId: string): LanguageProvider {
    return this.languagePerId.get(languageId)
  }

  private configurationChanged(e?: ConfigurationChangeEvent): void {
    if (!e || e.affectsConfiguration('tsserver')) {
      const config = workspace.getConfiguration('tsserver')
      this.reportStyleCheckAsWarnings = config.get('reportStyleChecksAsWarnings', true)
    }
  }

  public async findLanguage(uri: string): Promise<LanguageProvider> {
    try {
      let doc = this.client.getDocument(uri)
      let languages = Array.from(this.languagePerId.values())
      // possible not opened
      if (doc) return languages.find(language => language.handles(uri, doc.textDocument))
      return languages.find(language => language.handlesUri(Uri.parse(uri)))
    } catch {
      return undefined
    }
  }

  public async handles(uri: string): Promise<boolean> {
    const provider = await this.findLanguage(uri)
    if (provider) return true
    return this.client.bufferSyncSupport.handles(uri)
  }

  private triggerAllDiagnostics(): void {
    for (const language of this.languagePerId.values()) {
      language.triggerAllDiagnostics()
    }
  }

  private populateService(): void {
    this.fileConfigurationManager.reset()

    for (const language of this.languagePerId.values()) {
      language.reInitialize()
    }
  }

  private async diagnosticsReceived(
    kind: DiagnosticKind,
    resource: string,
    diagnostics: Proto.Diagnostic[]
  ): Promise<void> {
    const language = await this.findLanguage(resource)
    if (language) {
      language.diagnosticsReceived(
        kind,
        resource,
        this.createMarkerData(diagnostics))
    }
  }

  private createMarkerData(diagnostics: Proto.Diagnostic[]): (Diagnostic & { reportUnnecessary: any, reportDeprecated: any })[] {
    const ds = diagnostics.map(tsDiag => this.tsDiagnosticToLspDiagnostic(tsDiag))
    return formatDiagnostic(ds) as any
  }

  private tsDiagnosticToLspDiagnostic(diagnostic: Proto.Diagnostic): (Diagnostic & { reportUnnecessary: any, reportDeprecated: any }) {
    const { start, end, text } = diagnostic
    const range = {
      start: typeConverters.Position.fromLocation(start),
      end: typeConverters.Position.fromLocation(end)
    }
    let relatedInformation: DiagnosticRelatedInformation[]
    if (diagnostic.relatedInformation) {
      relatedInformation = diagnostic.relatedInformation.map(o => {
        let { span, message } = o
        return {
          location: typeConverters.Location.fromTextSpan(this.client.toResource(span.file), span),
          message
        }
      })
    }
    let tags: DiagnosticTag[] | undefined = []
    if (diagnostic.reportsUnnecessary) {
      tags.push(DiagnosticTag.Unnecessary)
    }
    if (diagnostic.reportsDeprecated) {
      tags.push(DiagnosticTag.Deprecated)
    }
    tags = tags.length ? tags : undefined

    return {
      range,
      tags,
      message: text,
      code: diagnostic.code ? diagnostic.code : null,
      severity: this.getDiagnosticSeverity(diagnostic),
      reportDeprecated: diagnostic.reportsDeprecated,
      reportUnnecessary: diagnostic.reportsUnnecessary,
      source: diagnostic.source,
      relatedInformation
    }
  }

  private getDiagnosticSeverity(diagnostic: Proto.Diagnostic): DiagnosticSeverity {
    if (
      this.reportStyleCheckAsWarnings &&
      this.isStyleCheckDiagnostic(diagnostic.code) &&
      diagnostic.category === PConst.DiagnosticCategory.error
    ) {
      return DiagnosticSeverity.Warning
    }

    switch (diagnostic.category) {
      case PConst.DiagnosticCategory.error:
        return DiagnosticSeverity.Error

      case PConst.DiagnosticCategory.warning:
        return DiagnosticSeverity.Warning

      case PConst.DiagnosticCategory.suggestion:
        return DiagnosticSeverity.Hint

      default:
        return DiagnosticSeverity.Error
    }
  }

  private isStyleCheckDiagnostic(code: number | undefined): boolean {
    return typeof code === 'number' && styleCheckDiagnostics.has(code)
  }

  private getAllModeIds(descriptions: LanguageDescription[], pluginManager: PluginManager): string[] {
    const allModeIds = flatten([
      ...descriptions.map(x => x.languageIds),
      ...pluginManager.plugins.map(x => x.languages)
    ])
    return allModeIds
  }
}
