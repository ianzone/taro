/**
 * 这里我们需要关心的小程序种类有两类：
 * 1. 模板递归：
 *  - 支持：tmpl0 套 tmpl0
 *  - 不支持：这就使得我们必须生成多级的模板，tmpl0 套 tmpl1，tmpl1 套 tmpl2……
 *           直到超过阈值 N (N = config.miniapp.baseLevel) tmplN 会套组件 comp，组件 comp 重新再套 tmpl0。
 * 2. 小程序脚本语言（wxs, sjs, etc...）：
 *  - 支持：可以在模板使用函数缩减模板大小或提高性能（存疑），例如判断一个值是不是假值（falsy value）。
 *         将来或许会把数据序列化^1 的操作也放到小程序脚本语言里。
 *  - 不支持：使用纯 *xml 语法
 *
 * ^1: packages/taro-runtime/src/hydrate.ts
*/

import {
  focusComponents,
  internalComponents,
  nestElements,
  singleQuote,
  voidElements
} from './components'
import { COMPILE_MODE_IDENTIFIER_PREFIX } from './constants'
import { isBooleanStringLiteral, isFunction, isNumber, isObjectStringLiteral, isString } from './is'
import { Shortcuts } from './shortcuts'
import { capitalize, getComponentsAlias, hasOwn, indent, toCamelCase, toDashed, toKebabCase } from './utils'

interface Component {
  nodeName: string
  nodeAlias: string
  attributes: Attributes
}

interface Components {
  [key: string]: Record<string, string>
}

interface ComponentConfig {
  includes: Set<string>
  exclude: Set<string>
  thirdPartyComponents: Map<string, Set<string>>
  includeAll: boolean
}

export interface IAdapter {
  if: string
  else: string
  elseif: string
  for: string
  forItem: string
  forIndex: string
  key: string
  xs?: string
  type: string
}

export type Attributes = Record<string, string>

export const styles = {
  style: `i.${Shortcuts.Style}`,
  class: `i.${Shortcuts.Class}`
}

export const events = {
  bindtap: 'eh'
}

const weixinAdapter: IAdapter = {
  if: 'wx:if',
  else: 'wx:else',
  elseif: 'wx:elif',
  for: 'wx:for',
  forItem: 'wx:for-item',
  forIndex: 'wx:for-index',
  key: 'wx:key',
  xs: 'wxs',
  type: 'weapp'
}

export class BaseTemplate {
  protected _baseLevel = 0
  protected _isUseXS = true
  protected _isUseCompileMode = false
  protected exportExpr = 'module.exports ='
  protected isSupportRecursive: boolean
  protected miniComponents: Components
  protected thirdPartyPatcher: Record<string, Record<string, string>> = {}
  protected modifyCompProps?: (compName: string, target: Record<string, string>) => Record<string, string>
  protected modifyLoopBody?: (child: string, nodeName: string) => string
  protected modifyLoopContainer?: (children: string, nodeName: string) => string
  protected modifyTemplateResult?: (res: string, nodeName: string, level: number, children: string) => string
  protected modifyThirdPartyLoopBody?: (child: string, nodeName: string) => string
  public supportXS = false
  public isXMLSupportRecursiveReference = true
  public Adapter = weixinAdapter
  /** 组件列表 */
  public internalComponents = internalComponents
  /** 可以 focus 聚焦的组件 */
  public focusComponents: Set<string> = focusComponents
  /** 不需要渲染子节点的元素 */
  public voidElements: Set<string> = voidElements
  /** 可以递归调用自身的组件 */
  public nestElements: Map<string, number> = nestElements
  public componentsAlias

  set baseLevel (lv) {
    this._baseLevel = lv
  }

  get baseLevel () {
    return this._baseLevel
  }

  set isUseCompileMode (isUse) {
    this._isUseCompileMode = isUse
  }

  get isUseCompileMode () {
    return this._isUseCompileMode
  }

  set isUseXS (isUse) {
    this._isUseXS = this.supportXS && isUse
  }

  get isUseXS () {
    return this._isUseXS
  }

  private buildAttribute (attrs: Attributes, nodeName: string): string {
    return Object.keys(attrs)
      .map(k => `${k}="${k.startsWith('bind') || k.startsWith('on') || k.startsWith('catch') ? attrs[k] : `{${this.getAttrValue(attrs[k], k, nodeName)}}`}" `)
      .join('')
  }

  protected replacePropName (name: string, value: string, _componentName?: string, _componentAlias?) {
    if (value === 'eh') return name.toLowerCase()
    return name
  }

  public createMiniComponents (components: Components) {
    const result: Components = Object.create(null)

    for (const key in components) {
      if (hasOwn(components, key)) {
        let component = components[key]
        const compName = toDashed(key)
        const newComp: Record<string, string> = Object.create(null)
        const componentAlias = this.componentsAlias[compName]

        if (isFunction(this.modifyCompProps)) {
          component = this.modifyCompProps(compName, component)
        }

        for (let prop in component) {
          if (hasOwn(component, prop)) {
            const propInCamelCase = toCamelCase(prop)
            const propAlias = componentAlias[propInCamelCase] || propInCamelCase
            let propValue = component[prop]

            if (prop.startsWith('bind') || propValue === 'eh') {
              propValue = 'eh'
            } else if (propValue === '') {
              propValue = `i.${propAlias}`
            } else if (isBooleanStringLiteral(propValue) || isNumber(+propValue)) {
              propValue = this.isUseXS
                ? `xs.b(i.${propAlias},${propValue})`
                : `i.${propAlias}===undefined?${propValue}:i.${propAlias}`
            } else if (isObjectStringLiteral(propValue)) {
              propValue = this.isUseXS
                ? `xs.d(i.${propAlias})`
                : `i.${propAlias}===undefined?${propValue}:i.${propAlias}`
            } else {
              propValue = `i.${propAlias}||${propValue || singleQuote('')}`
            }

            prop = this.replacePropName(prop, propValue, compName, componentAlias)

            newComp[prop] = propValue
          }
        }
        if (compName !== 'block') {
          Object.assign(newComp, styles, this.getEvents())
        }

        if (compName === 'swiper-item') {
          delete newComp.style
        }

        if (compName === 'view') {
          const reg = /^(bind|on)(touchmove|TouchMove)$/
          const comp = { ...newComp }
          Object.keys(comp).forEach(originKey => {
            if (!reg.test(originKey)) return

            const key = originKey.replace(reg, 'catch$2')
            comp[key] = comp[originKey]
            delete comp[originKey]
          })

          result['catch-view'] = comp
        }

        if (compName === 'view' || compName === 'text' || compName === 'image') {
          const comp: Record<any, any> = {}
          Object.keys(newComp).forEach(key => {
            const value = newComp[key]
            if (value !== 'eh') comp[key] = value
          })
          result[`static-${compName}`] = comp
          if (compName === 'view') {
            result['pure-view'] = {
              style: comp.style,
              class: comp.class
            }

            result['click-view'] = {
              style: comp.style,
              class: comp.class,
              ...this.getClickEvent()
            }
          }
        }

        if (compName === 'slot' || compName === 'slot-view') {
          result[compName] = {
            slot: newComp?.name,
            ...styles
          }
        } else if (compName === 'native-slot') {
          result[compName] = {
            name: newComp?.name,
          }
        } else if (compName === 'list-builder') {
          result[compName] = {
            ...newComp,
            list: 'i.cn',
          }
        } else {
          result[compName] = newComp
        }
      }
    }

    return result
  }

  protected buildBaseTemplate () {
    const Adapter = this.Adapter
    const data = !this.isSupportRecursive && this.isUseXS
      ? `${this.dataKeymap(`i:item,c:1,l:xs.f('',item.${Shortcuts.NodeName})`)}`
      : this.isSupportRecursive
        ? this.dataKeymap('i:item')
        : this.dataKeymap('i:item,c:1')
    const xs = this.isUseXS
      ? (this.isSupportRecursive
        ? `xs.a(0, item.${Shortcuts.NodeName})`
        : `xs.a(0, item.${Shortcuts.NodeName}, '')`)
      : `'tmpl_0_' + item.${Shortcuts.NodeName}`
    return `${this.buildXsImportTemplate()}<template name="taro_tmpl">
  <template is="{{${xs}}}" data="{{${data}}}" ${Adapter.for}="{{root.${Shortcuts.Childnodes}}}" ${Adapter.key}="${Shortcuts.Sid}" />
</template>
`
  }

  protected buildThirdPartyAttr (attrs: Set<string>, patcher: Record<string, string> = {}) {
    return Array.from(attrs).reduce((str, attr) => {
      if (attr.startsWith('@')) {
        // vue2
        let value = attr.slice(1)
        if (value.indexOf('-') > -1) {
          value = `:${value}`
        }
        return str + ` bind${value}="eh"`
      } else if (attr.startsWith('bind')) {
        return str + ` ${attr}="eh"`
      } else if (attr.startsWith('on')) {
        // react, vue3
        let value = toKebabCase(attr.slice(2))
        if (value.indexOf('-') > -1) {
          // 兼容如 vant 某些组件的 bind:a-b 这类属性
          value = `:${value}`
        }
        return str + ` bind${value}="eh"`
      } else if (attr === 'class') {
        return str + ` class="{{i.${Shortcuts.Class}}}"`
      } else if (attr === 'style') {
        return str + ` style="{{i.${Shortcuts.Style}}}"`
      }

      const patchValue = patcher[attr]
      if (isBooleanStringLiteral(patchValue) || isNumber(patchValue) || isString(patchValue)) {
        let propValue = ''

        if (this.isUseXS) {
          if (isObjectStringLiteral(patchValue)) {
            propValue = `xs.d(i.${toCamelCase(attr)})`
          }
          propValue = `xs.b(i.${toCamelCase(attr)},${patchValue})`
        } else {
          propValue = `i.${toCamelCase(attr)}===undefined?${patchValue}:i.${toCamelCase(attr)}`
        }

        return str + ` ${attr}="{{${propValue}}}"`
      }
      return str + ` ${attr}="{{i.${toCamelCase(attr)}}}"`
    }, '')
  }

  protected buildComponentTemplate (comp: Component, level: number) {
    return this.focusComponents.has(comp.nodeName)
      ? this.buildFocusComponentTemplate(comp, level)
      : this.buildStandardComponentTemplate(comp, level)
  }

  private getChildrenTemplate (level: number, useSlotItem = false) {
    const { isSupportRecursive, isUseXS, Adapter, isUseCompileMode = true } = this
    const isLastRecursiveComp = !isSupportRecursive && level + 1 === this.baseLevel
    const isUnRecursiveXs = !this.isSupportRecursive && isUseXS

    const forAttribute = `${Adapter.for}="{{i.${Shortcuts.Childnodes}}}" ${Adapter.key}="${Shortcuts.Sid}"`
    if (isLastRecursiveComp) {
      const data = isUnRecursiveXs
        ? `${this.dataKeymap('i:item,c:c,l:l')}`
        : this.isSupportRecursive
          ? this.dataKeymap('i:item')
          : this.dataKeymap('i:item,c:c')

      const tmpl = isUseXS
        ? `<template is="{{xs.e(${level})}}" data="{{${data}}}" ${forAttribute} />`
        : `<template is="tmpl_${level}_${Shortcuts.Container}" data="{{${data}}}" ${forAttribute} />`
      if (useSlotItem) {
        return `<block slot:item slot:index>${tmpl.replace(forAttribute, '')}</block>`
      }
      return tmpl
    } else {
      const data = isUnRecursiveXs
        // TODO: 此处直接 c+1，不是最优解，变量 c 的作用是监测组件嵌套的层级是否大于 baselevel
        // 但目前的监测方法用于所有组件嵌套的总和，应该分开组件计算，单个组件嵌套层级大于 baselevel 时，再进入 comp 组件中进行新的嵌套
        ? `${this.dataKeymap(`i:item,c:c+1,l:xs.f(l,item.${Shortcuts.NodeName})`)}`
        : this.isSupportRecursive
          ? `${this.dataKeymap('i:item')}`
          : `${this.dataKeymap('i:item,c:c+1')}`

      const xs = !this.isSupportRecursive
        ? `xs.a(c, item.${Shortcuts.NodeName}, l)`
        : `xs.a(0, item.${Shortcuts.NodeName})`

      const tmpl = isUseXS
        ? `<template is="{{${xs}}}" data="{{${data}}}" ${forAttribute} />`
        : isSupportRecursive
          ? `<template is="{{'tmpl_0_' + item.${Shortcuts.NodeName}}}" data="{{${data}}}" ${forAttribute} />`
          : isUseCompileMode
            ? `<template is="{{'tmpl_' + (item.${Shortcuts.NodeName}[0]==='${COMPILE_MODE_IDENTIFIER_PREFIX}' ? 0 : c) + '_' + item.${Shortcuts.NodeName}}}" data="{{${data}}}" ${forAttribute} />`
            : `<template is="{{'tmpl_' + c + '_' + item.${Shortcuts.NodeName}}}" data="{{${data}}}" ${forAttribute} />`

      if (useSlotItem) {
        return `<block slot:item slot:index>${tmpl.replace(forAttribute, '')}</block>`
      }
      return tmpl
    }
  }

  private getChildren (comp: Component, level: number): string {
    const { isSupportRecursive } = this
    const nextLevel = isSupportRecursive ? 0 : level + 1
    const isListBuilder = comp.nodeName === 'list-builder'

    let child = this.getChildrenTemplate(nextLevel, isListBuilder)

    if (isFunction(this.modifyLoopBody)) {
      child = this.modifyLoopBody(child, comp.nodeName)
    }
    let children = this.voidElements.has(comp.nodeName)
      ? ''
      : `
    ${indent(child, 6)}
  `

    if (isFunction(this.modifyLoopContainer)) {
      children = this.modifyLoopContainer(children, comp.nodeName)
    }

    return children
  }

  protected buildFocusComponentTemplate (comp: Component, level: number) {
    const children = this.getChildren(comp, level)
    const nodeName = comp.nodeName
    const nodeAlias = comp.nodeAlias
    const attrs = { ...comp.attributes }
    const templateName = this.isUseXS
      ? `xs.c(i, 'tmpl_${level}_')`
      : `i.focus ? 'tmpl_${level}_${nodeAlias}_focus' : 'tmpl_${level}_${nodeAlias}_blur'`
    delete attrs.focus

    let res = `
<template name="tmpl_${level}_${nodeAlias}">
  <template is="{{${templateName}}}" data="{{${this.isSupportRecursive ? this.dataKeymap('i:i') : this.dataKeymap('i:i,c:c')}}}" />
</template>

<template name="tmpl_${level}_${nodeAlias}_focus">
  <${nodeName} ${this.buildAttribute(comp.attributes, nodeName)} id="{{i.uid||i.sid}}" data-sid="{{i.sid}}">${children}</${nodeName}>
</template>

<template name="tmpl_${level}_${nodeAlias}_blur">
  <${nodeName} ${this.buildAttribute(attrs, nodeName)} id="{{i.uid||i.sid}}" data-sid="{{i.sid}}">${children}</${nodeName}>
</template>
`
    if (isFunction(this.modifyTemplateResult)) {
      res = this.modifyTemplateResult(res, nodeName, level, children)
    }

    return res
  }

  protected buildStandardComponentTemplate (comp: Component, level: number) {
    const children = this.getChildren(comp, level)
    const nodeAlias = comp.nodeAlias

    let nodeName = ''
    switch (comp.nodeName) {
      case 'slot':
      case 'slot-view':
      case 'catch-view':
      case 'static-view':
      case 'pure-view':
      case 'click-view':
        nodeName = 'view'
        break
      case 'static-text':
        nodeName = 'text'
        break
      case 'static-image':
        nodeName = 'image'
        break
      case 'native-slot':
        nodeName = 'slot'
        break
      default:
        nodeName = comp.nodeName
        break
    }

    let res = `
<template name="tmpl_${level}_${nodeAlias}">
  <${nodeName} ${this.buildAttribute(comp.attributes, comp.nodeName)} id="{{i.uid||i.sid}}" data-sid="{{i.sid}}">${children}</${nodeName}>
</template>
`

    if (isFunction(this.modifyTemplateResult)) {
      res = this.modifyTemplateResult(res, comp.nodeName, level, children)
    }

    return res
  }

  protected buildPlainTextTemplate (level: number): string {
    return `
<template name="tmpl_${level}_${this.componentsAlias['#text']._num}">
  <block>{{i.${Shortcuts.Text}}}</block>
</template>
`
  }

  protected buildThirdPartyTemplate (level: number, componentConfig: ComponentConfig) {
    const { isSupportRecursive, isUseXS, nestElements } = this
    const nextLevel = isSupportRecursive ? 0 : level + 1
    let template = ''

    componentConfig.thirdPartyComponents.forEach((attrs, compName) => {
      if (compName === 'custom-wrapper') {
        template += `
<template name="tmpl_${level}_${compName}">
  <${compName} i="{{i}}" ${!isSupportRecursive && isUseXS ? 'l="{{l}}"' : ''} id="{{i.uid||i.sid}}" data-sid="{{i.sid}}">
  </${compName}>
</template>
  `
      } else {
        if (!isSupportRecursive && isUseXS && nestElements.has(compName) && level + 1 > nestElements.get(compName)!) return

        let child = this.getChildrenTemplate(nextLevel)

        if (isFunction(this.modifyThirdPartyLoopBody)) {
          child = this.modifyThirdPartyLoopBody(child, compName)
        }

        const children = this.voidElements.has(compName)
          ? ''
          : `
    ${child}
  `

        template += `
<template name="tmpl_${level}_${compName}">
  <${compName} ${this.buildThirdPartyAttr(attrs, this.thirdPartyPatcher[compName] || {})} id="{{i.uid||i.sid}}" data-sid="{{i.sid}}">${children}</${compName}>
</template>
  `
      }
    })

    return template
  }

  // 最后一层的 comp 需要引用 container 进行重新的模版循环，其他情况不需要 container
  protected buildContainerTemplate (level: number) {
    const tmpl = `<block ${this.Adapter.if}="{{i.nn === '${this.componentsAlias['#text']._num}'}}">
    <template is="tmpl_0_${this.componentsAlias['#text']._num}" data="{{${this.dataKeymap('i:i')}}}" />
  </block>
  <block ${this.Adapter.else}>
    ${!this.isSupportRecursive && this.isUseXS ? '<comp i="{{i}}" l="{{l}}" />' : '<comp i="{{i}}" />'}
  </block>`

    return `
<template name="tmpl_${level}_${Shortcuts.Container}">
  ${tmpl}
</template>
`
  }

  protected dataKeymap (keymap: string) {
    return keymap
  }

  protected getEvents (): any {
    return events
  }

  protected getClickEvent (): any {
    return { bindtap: 'eh' }
  }

  protected getAttrValue (value: string, _key: string, _nodeName: string) {
    return `{${value}}`
  }

  public buildXsTemplate (_filePath?: string) {
    return ''
  }

  public buildXsImportTemplate (_filePath?: string) {
    return this.isUseXS ? this.buildXsTemplate(_filePath) + '\n' : ''
  }

  public buildPageTemplate = (baseTempPath: string, _page?: { content: Record<string, any>, path: string }) => {
    const template = `<import src="${baseTempPath}"/>
<template is="taro_tmpl" data="{{${this.dataKeymap('root:root')}}}" />`

    return template
  }

  public buildBaseComponentTemplate = (ext: string) => {
    const data = !this.isSupportRecursive && this.isUseXS
      ? this.dataKeymap(`i:i,c:1,l:xs.f('',i.${Shortcuts.NodeName})`)
      : this.isSupportRecursive
        ? this.dataKeymap('i:i')
        : this.dataKeymap('i:i,c:1')

    // 此处需要重新引入 xs 函数，否则会出现 ws.f() 在 comp.wxml 和 custom-wrapper.wxml 中永远返回 undefined 的问题 #14599
    return `<import src="./base${ext}" />
${this.buildXsImportTemplate()}<template is="{{'tmpl_0_' + i.${Shortcuts.NodeName}}}" data="{{${data}}}" />`
  }

  public buildCustomComponentTemplate = (ext: string) => {
    const Adapter = this.Adapter
    const data = !this.isSupportRecursive && this.isUseXS
      ? `${this.dataKeymap(`i:item,c:1,l:xs.f('',item.${Shortcuts.NodeName})`)}`
      : this.isSupportRecursive
        ? this.dataKeymap('i:item')
        : this.dataKeymap('i:item,c:1')

    // 此处需要重新引入 xs 函数，否则会出现 ws.f() 在 comp.wxml 和 custom-wrapper.wxml 中永远返回 undefined 的问题 #14599
    return `<import src="./base${ext}" />
${this.buildXsImportTemplate()}<template is="{{'tmpl_0_' + item.${Shortcuts.NodeName}}}" data="{{${data}}}" ${Adapter.for}="{{i.${Shortcuts.Childnodes}}}" ${Adapter.key}="${Shortcuts.Sid}" />
`
  }

  public buildXScript = () => {
    return `${this.exportExpr} {
  a: ${this.buildXSTmplName()},
  b: function (a, b) {
    return a === undefined ? b : a
  },
  c: ${this.buildXSTepFocus(Shortcuts.NodeName)},
  d: function (a) {
    return a === undefined ? {} : a
  },
  e: function (n) {
    return 'tmpl_' + n + '_${Shortcuts.Container}'
  },
  ${this.buildXSTmpExtra()}
}`
  }

  public mergeComponents (ctx, patch: Record<string, Record<string, string>>) {
    ctx.helper.recursiveMerge(this.internalComponents, patch)
  }

  public mergeThirdPartyComponents (patch: Record<string, Record<string, string>>) {
    this.thirdPartyPatcher = patch
  }

  protected buildXSTmplName () {
    return `function (l, n) {
    return 'tmpl_' + l + '_' + n
  }`
  }

  protected buildXSTepFocus (nn: string) {
    return `function(i, prefix) {
    var s = i.focus !== undefined ? 'focus' : 'blur'
    return prefix + i.${nn} + '_' + s
  }`
  }

  protected buildXSTmpExtra () {
    return ''
  }
}

export class RecursiveTemplate extends BaseTemplate {
  public isSupportRecursive = true

  public buildTemplate = (componentConfig: ComponentConfig) => {
    let template = this.buildBaseTemplate()
    if (!this.miniComponents) {
      this.componentsAlias = getComponentsAlias(this.internalComponents)
      this.miniComponents = this.createMiniComponents(this.internalComponents)
    }
    const ZERO_FLOOR = 0
    const components = Object.keys(this.miniComponents)
      .filter(c => componentConfig.includes.size && !componentConfig.includeAll ? componentConfig.includes.has(c) : true)

    template = components.reduce((current, nodeName) => {
      const attributes: Attributes = this.miniComponents[nodeName]
      const nodeAlias = this.componentsAlias[nodeName]._num
      return current + this.buildComponentTemplate({ nodeName, nodeAlias, attributes }, ZERO_FLOOR)
    }, template)

    template += this.buildPlainTextTemplate(ZERO_FLOOR)
    template += this.buildThirdPartyTemplate(ZERO_FLOOR, componentConfig)

    return template
  }
}

export class UnRecursiveTemplate extends BaseTemplate {
  isSupportRecursive = false
  protected _baseLevel = 16
  private componentConfig: ComponentConfig

  public buildTemplate = (componentConfig: ComponentConfig) => {
    this.componentConfig = componentConfig
    if (!this.miniComponents) {
      this.componentsAlias = getComponentsAlias(this.internalComponents)
      this.miniComponents = this.createMiniComponents(this.internalComponents)
    }
    const components = Object.keys(this.miniComponents)
      .filter(c => componentConfig.includes.size && !componentConfig.includeAll ? componentConfig.includes.has(c) : true)

    let template = this.buildBaseTemplate()
    for (let i = 0; i < this.baseLevel; i++) {
      template += this.isUseXS
        ? this.buildOptimizeFloor(i, components, this.baseLevel === i + 1)
        : this.buildFloor(i, components, this.baseLevel === i + 1)
    }

    return template
  }

  protected buildFloor (level: number, components: string[], restart = false) {
    if (restart) return this.buildContainerTemplate(level)

    let template = components.reduce((current, nodeName) => {
      const attributes: Attributes = this.miniComponents[nodeName]
      const nodeAlias = this.componentsAlias[nodeName]._num
      return current + this.buildComponentTemplate({ nodeName, nodeAlias, attributes }, level)
    }, '')

    template += this.buildPlainTextTemplate(level)
    template += this.buildThirdPartyTemplate(level, this.componentConfig)

    return template
  }

  protected buildOptimizeFloor (level: number, components: string[], restart = false) {
    if (restart) return this.buildContainerTemplate(level)

    let template = components.reduce((current, nodeName) => {
      if (level !== 0) {
        if (!this.nestElements.has(nodeName)) {
          // 不可嵌套自身的组件只需输出一层模板
          return current
        } else {
          // 部分可嵌套自身的组件实际上不会嵌套过深，这里按阈值限制层数
          const max = this.nestElements.get(nodeName)!
          if (max > 0 && level >= max) {
            return current
          }
        }
      }
      const attributes: Attributes = this.miniComponents[nodeName]
      const nodeAlias = this.componentsAlias[nodeName]._num
      return current + this.buildComponentTemplate({ nodeName, nodeAlias, attributes }, level)
    }, '')

    if (level === 0) template += this.buildPlainTextTemplate(level)
    template += this.buildThirdPartyTemplate(level, this.componentConfig)

    return template
  }

  protected buildXSTmplName () {
    const isLoopComps = [
      ...Array.from(this.nestElements.keys()),
      ...Array.from(this.componentConfig.thirdPartyComponents.keys())
    ]
    const isLoopCompsSet = new Set(isLoopComps)
    const hasMaxComps: string[] = []
    this.nestElements.forEach((max, comp) => {
      if (max > 1) {
        hasMaxComps.push(comp)
      } else if (max === 1 && isLoopCompsSet.has(comp)) {
        isLoopCompsSet.delete(comp)
      }
    })

    const componentsAlias = this.componentsAlias
    const listA = Array.from(isLoopCompsSet).map(item => componentsAlias[item]?._num || item)
    const listB = hasMaxComps.map(item => componentsAlias[item]?._num || item)
    const containerLevel = this.baseLevel - 1

    // l >= containerLevel 是为了避免 baselevel 倒数两三层几层组件恰好不是 listA 中的组件，而最后一个组件又刚好是 listA 的组件，导致出现 l >= baselevel 却没有走入新的嵌套循环的问题 #14883
    return `function (l, n, s) {
    var a = ${JSON.stringify(listA)}
    var b = ${JSON.stringify(listB)}
    if (a.indexOf(n) === -1) {
      l = 0
    }
    if (b.indexOf(n) > -1) {
      var u = s.split(',')
      var depth = 0
      for (var i = 0; i < u.length; i++) {
        if (u[i] === n) depth++
      }
      l = depth
    }
    if (l >= ${containerLevel}) {
      return 'tmpl_${containerLevel}_${Shortcuts.Container}'
    }
    return 'tmpl_' + l + '_' + n
  }`
  }

  protected buildXSTmpExtra () {
    const hasMaxComps: string[] = []
    this.nestElements.forEach((max, comp) => {
      if (max > 1) hasMaxComps.push(comp)
    })

    const componentsAlias = this.componentsAlias
    const listA = hasMaxComps.map(item => componentsAlias[item]?._num || item)

    return `f: function (l, n) {
    var b = ${JSON.stringify(listA)}
    if (b.indexOf(n) > -1) {
      if (l) l += ','
      l += n
    }
    return l
  }`
  }
}

export {
  capitalize,
  internalComponents,
  Shortcuts,
  toCamelCase
}
