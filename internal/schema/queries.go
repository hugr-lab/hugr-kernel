package schema

const typeQuery = `query IntrospectType($name: String!) {
  __type(name: $name) {
    name kind description
    fields {
      name description isDeprecated deprecationReason
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      args { name description type { name kind ofType { name kind ofType { name kind } } } defaultValue }
    }
    inputFields { name description type { name kind ofType { name kind } } defaultValue }
    enumValues { name description isDeprecated deprecationReason }
  }
}`

const rootTypesQuery = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
  }
}`

const directivesQuery = `{
  __schema {
    directives {
      name description locations
      args { name description type { name kind ofType { name kind } } defaultValue }
    }
  }
}`
