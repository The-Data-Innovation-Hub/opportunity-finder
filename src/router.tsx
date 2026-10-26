import {createRootRoute, createRoute, createRouter} from '@tanstack/react-router'
import {Layout} from './components/Layout'
import {SignIn} from './pages/SignIn'
import {Home} from './pages/Home'
import {CompanyReport} from './pages/CompanyReport'
import {CompanySettings} from './pages/CompanySettings'
import {Admin} from './pages/Admin'
import {NotFound} from './pages/NotFound'

const root = createRootRoute({component: Layout, notFoundComponent: NotFound})
const signIn = createRoute({getParentRoute: () => root, path: '/sign-in', component: SignIn})
const home = createRoute({getParentRoute: () => root, path: '/', component: Home})
const company = createRoute({getParentRoute: () => root, path: '/companies/$companyId', component: () => <CompanyReport {...company.useParams()} />})
const report = createRoute({getParentRoute: () => root, path: '/companies/$companyId/reports/$reportId', component: () => <CompanyReport {...report.useParams()} />})
const settings = createRoute({getParentRoute: () => root, path: '/companies/$companyId/settings', component: CompanySettings})
const admin = createRoute({getParentRoute: () => root, path: '/admin', component: Admin})

export const router = createRouter({routeTree: root.addChildren([signIn, home, company, report, settings, admin])})

declare module '@tanstack/react-router' {
	interface Register {router: typeof router}
}
