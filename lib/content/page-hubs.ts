// URL hub segments that mark a niche, service or location page. Shared by
// resolvePageIntent (generator) and structureTypeForUrl (QA, editor) so both
// classify /what-we-do/income-tax the same way as /services/income-tax.
export const NICHE_HUBS: readonly string[] = ['industries', 'industry', 'who-we-serve', 'industries-we-serve']
export const SERVICE_HUBS: readonly string[] = ['services', 'service', 'what-we-do', 'our-services', 'solutions']
export const LOCATION_HUBS: readonly string[] = ['locations', 'location', 'areas-we-serve', 'service-areas']
