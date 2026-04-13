import {promises} from 'fs'
import {
  ActionInterface,
  GitHubResponse,
  PrivacyLevel,
  Sponsor,
  Status,
  Urls
} from './constants'
import {render} from 'mustache'
import {
  extractErrorMessage,
  suppressSensitiveInformation,
  sanitizeAndClean,
  replaceAll,
  parseTokens,
  isNullOrUndefined
} from './util'
import {info} from '@actions/core'

interface MergedSponsor {
  sponsor: Sponsor
  sponsoredAccountsCount: number
  firstSeenIndex: number
}

const getResponseData = (
  response: GitHubResponse,
  organization: boolean
): GitHubResponse['data']['organization'] | GitHubResponse['data']['viewer'] =>
  organization ? response?.data?.organization : response?.data?.viewer

/**
 * Fetches sponsors from the GitHub Sponsors API.
 */
export async function getSponsors(
  action: ActionInterface
): Promise<GitHubResponse> {
  try {
    const tokens = parseTokens(action.token)

    info(
      `Fetching data from the GitHub API for ${tokens.length} account${tokens.length === 1 ? '' : 's'} as ${
        action.organization ? 'Organization' : 'User'
      }… ⚽`
    )

    const query = `query { 
      ${
        action.organization
          ? `organization (login: "${process.env.GITHUB_REPOSITORY_OWNER}")`
          : `viewer`
      } {
        login
        sponsorshipsAsMaintainer(first: 100, orderBy: {field: CREATED_AT, direction: ASC}, includePrivate: ${action.includePrivate}, activeOnly: ${
          action.activeOnly
        }) {
          totalCount
          pageInfo {
            endCursor
          }
          nodes {
            sponsorEntity {
              ... on Organization {
                name
                login
                url
                websiteUrl
              }
              ... on User {
                name
                login
                url
                websiteUrl
              }
            }
            createdAt
            privacyLevel
            tier {
              monthlyPriceInCents
            }
          }
        }
      }
    }`

    const responses = await Promise.all(
      tokens.map(async token => {
        const data = await fetch(`${Urls.GITHUB_API}/graphql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            query
          })
        })

        return data.json() as Promise<GitHubResponse>
      })
    )

    const mergedNodes = responses.flatMap(response => {
      const responseData = getResponseData(response, action.organization)
      return responseData?.sponsorshipsAsMaintainer?.nodes || []
    })

    const sponsorshipsAsMaintainer = {
      totalCount: mergedNodes.length,
      pageInfo: {
        endCursor: ''
      },
      nodes: mergedNodes
    }

    return {
      data: action.organization
        ? {
            organization: {
              sponsorshipsAsMaintainer
            }
          }
        : {
            viewer: {
              sponsorshipsAsMaintainer
            }
          }
    }
  } catch (error) {
    throw new Error(
      `There was an error with the GitHub API request: ${suppressSensitiveInformation(
        extractErrorMessage(error),
        action
      )} ❌`
    )
  }
}

/**
 * Generates the sponsorship template.
 */
export function generateTemplate(
  response: GitHubResponse,
  action: ActionInterface
): string {
  let template = ``

  info('Generating template… ✨')

  /**
   * Determines if the response is from an organization or a user.
   * Performs checks to see if the data is available before we
   * reference it as the API results can be somewhat sporadic.
   */
  const data = getResponseData(response, action.organization)

  const sponsorshipsAsMaintainer = data?.sponsorshipsAsMaintainer

  if (sponsorshipsAsMaintainer) {
    let filteredSponsors = sponsorshipsAsMaintainer.nodes.filter(
      (user: Sponsor) =>
        (user.tier && user.tier.monthlyPriceInCents
          ? user.tier.monthlyPriceInCents
          : 0) >= action.minimum
    )

    /**
     * If `includePrivate` is true here, we replace the private sponsors with a placeholder asset and anonymize all data to respect privacy.
     */
    if (action.includePrivate) {
      filteredSponsors = filteredSponsors.map((user: Sponsor) => {
        if (user.privacyLevel === PrivacyLevel.PRIVATE) {
          return {
            ...user,
            sponsorEntity: {
              name: 'Private Sponsor',
              login: '',
              url: 'https://github.com',
              websiteUrl: 'https://github.com',
              avatarUrl:
                'https://raw.githubusercontent.com/JamesIves/github-sponsors-readme-action/dev/.github/assets/placeholder.png'
            }
          }
        }
        return user
      })
    } else {
      /**
       * If `includePrivate` is false we filter out any priv1ate sponsors. This is a safeguard incase the GitHub API
       * decides to return private sponsors for some reason.
       */
      filteredSponsors = filteredSponsors.filter(
        (user: Sponsor) => user.privacyLevel !== PrivacyLevel.PRIVATE
      )
    }

    if (action.maximum > 0) {
      filteredSponsors = filteredSponsors.filter(
        (user: Sponsor) =>
          (user.tier && user.tier.monthlyPriceInCents
            ? user.tier.monthlyPriceInCents
            : 0) <= action.maximum
      )
    }

    const mergedSponsors = filteredSponsors.reduce((merged, sponsor, index) => {
      const sponsorLogin = sponsor.sponsorEntity.login
        ? sponsor.sponsorEntity.login.toLowerCase()
        : ''
      const key = !isNullOrUndefined(sponsorLogin)
        ? sponsorLogin
        : `private-${index}`
      const existingSponsor = merged.get(key)

      if (existingSponsor) {
        existingSponsor.sponsoredAccountsCount += 1
        return merged
      }

      merged.set(key, {
        sponsor,
        sponsoredAccountsCount: 1,
        firstSeenIndex: index
      })

      return merged
    }, new Map<string, MergedSponsor>())

    const orderedSponsors = [...mergedSponsors.values()]
      .sort((a, b) => {
        if (b.sponsoredAccountsCount !== a.sponsoredAccountsCount) {
          return b.sponsoredAccountsCount - a.sponsoredAccountsCount
        }

        return a.firstSeenIndex - b.firstSeenIndex
      })
      .map(({sponsor, sponsoredAccountsCount}) => ({
        ...sponsor,
        sponsoredAccountsCount
      }))

    info(
      `Found ${orderedSponsors.length} matching ${orderedSponsors.length === 1 ? 'sponsor' : 'sponsors'}… ${orderedSponsors.length > 0 ? '🎉' : '😢'}`
    )

    /**
     * If there are no valid sponsors then we return the provided fallback.
     */
    if (!orderedSponsors.length) {
      return action.fallback
    }

    orderedSponsors.map(({sponsorEntity, sponsoredAccountsCount}) => {
      /**
       * Sanitizes and cleans the sponsor data individually.
       */
      const sanitizedSponsorEntity = {
        sponsoredAccountsCount,
        websiteUrl: sanitizeAndClean(
          sponsorEntity.websiteUrl || sponsorEntity.url
        ),
        name: sanitizeAndClean(sponsorEntity.name || ''),
        login: sanitizeAndClean(sponsorEntity.login),
        /**
         * The avatar URL provided by the GitHub API includes an expiration token so we circumvent this for now
         * by using a path that is always available.
         */
        avatarUrl: sponsorEntity.avatarUrl
          ? sponsorEntity.avatarUrl
          : `https://github.com/${sanitizeAndClean(sponsorEntity.login)}.png`
      }

      /**
       * Ensure that the template is safe to render by preventing the usage of triple brackets.
       */
      const safeTemplate = replaceAll(
        replaceAll(action.template, '{{{', '{{'),
        '}}}',
        '}}'
      )

      template = template += render(safeTemplate, sanitizedSponsorEntity)
    })
  } else {
    info(`No sponsorship data was found… ❌`)

    return action.fallback
  }

  return template
}

/**
 * Generates the updated file with the attached sponsorship template.
 */
export async function generateFile(
  response: GitHubResponse,
  action: ActionInterface
): Promise<Status> {
  try {
    info(`Generating updated ${action.file} file… 📁`)

    /** Replaces the content within the comments and re appends/prepends the comments to the replace for follow-up workflow runs. */
    const regex = new RegExp(
      `(<!-- ${action.marker} -->)[\\s\\S]*?(<!-- ${action.marker} -->)`,
      'g'
    )
    let data = await promises.readFile(action.file, 'utf8')

    if (!regex.test(data)) {
      return Status.SKIPPED
    }

    data = data.replace(regex, `$1${generateTemplate(response, action)}$2`)

    await promises.writeFile(action.file, data)

    return Status.SUCCESS
  } catch (error) {
    throw new Error(
      `There was an error generating the updated file: ${suppressSensitiveInformation(
        extractErrorMessage(error),
        action
      )} ❌`
    )
  }
}
