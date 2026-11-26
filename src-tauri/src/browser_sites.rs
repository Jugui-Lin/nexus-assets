use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSite {
    pub id: String,
    pub name: String,
    pub url: String,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserNavigation {
    pub sites: Vec<BrowserSite>,
    pub categories: Vec<String>,
    pub new_site_category: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserNavigationUpdate {
    pub revision: u64,
    pub navigation: BrowserNavigation,
}

#[derive(Deserialize, Serialize)]
pub struct BrowserNavigationSnapshot {
    pub available: bool,
    pub revision: u64,
    pub navigation: Option<BrowserNavigation>,
}
