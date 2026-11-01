import { createContext, useContext } from 'react'
import { translate, type Locale } from '../../shared/i18n'

export const LocaleContext = createContext<Locale>('en')

export type TFunction = (key: string, params?: Record<string, string | number>) => string

export function useT(): TFunction {
  const locale = useContext(LocaleContext)
  return (key, params) => translate(locale, key, params)
}
