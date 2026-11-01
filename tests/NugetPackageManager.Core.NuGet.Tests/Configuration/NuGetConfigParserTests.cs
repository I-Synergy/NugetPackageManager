// File: tests/NugetPackageManager.Core.NuGet.Tests/Configuration/NuGetConfigParserTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Ports the parser half of the TypeScript `nuget-config-resolver.test.ts`, including the two
// security decisions: `_xHHHH_` name decoding and no environment expansion below user level.

using System.Xml;
using NugetPackageManager.Core.NuGet.Configuration;

namespace NugetPackageManager.Core.NuGet.Tests.Configuration;

[TestClass]
public class NuGetConfigParserTests
{
    private static void AssertCsv(IEnumerable<string> actual, string expected) =>
        Assert.AreEqual(expected, string.Join(",", actual));

    private static Func<string, string?> Variables(params (string Name, string Value)[] variables) =>
        name => variables
            .Where(variable => variable.Name == name)
            .Select(variable => variable.Value)
            .FirstOrDefault();

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReadsSourcesAndIgnoresIncompleteEntries()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSources>
                <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
                <add key="no-url" />
                <add value="https://example.test/v3/index.json" />
              </packageSources>
            </configuration>
            """,
            expandEnvironment: true);

        Assert.AreEqual(1, file.Sources.Count);
        Assert.AreEqual("nuget.org", file.Sources[0].Name);
        Assert.AreEqual("https://api.nuget.org/v3/index.json", file.Sources[0].Url);
        Assert.IsFalse(file.Clear);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReportsClear_OnlyInsidePackageSources()
    {
        var withClear = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSources>
                <clear />
                <add key="only" value="https://example.test/v3/index.json" />
              </packageSources>
            </configuration>
            """,
            expandEnvironment: true);

        var unrelatedClear = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSources>
                <add key="only" value="https://example.test/v3/index.json" />
                <clearSomethingElse />
              </packageSources>
            </configuration>
            """,
            expandEnvironment: true);

        Assert.IsTrue(withClear.Clear);
        Assert.IsFalse(unrelatedClear.Clear);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_DisabledSources_OnlyWhenTheValueIsTrue()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <disabledPackageSources>
                <add key="off" value="true" />
                <add key="also-off" value="True" />
                <add key="on" value="false" />
              </disabledPackageSources>
            </configuration>
            """,
            expandEnvironment: true);

        AssertCsv(file.DisabledSources, "off,also-off");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Credentials_DecodesEscapedNamesAndPrefersClearText()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSourceCredentials>
                <rfh_x002F_nuget>
                  <add key="Username" value="dev" />
                  <add key="ClearTextPassword" value="plain" />
                  <add key="Password" value="encrypted" />
                </rfh_x002F_nuget>
              </packageSourceCredentials>
            </configuration>
            """,
            expandEnvironment: true);

        Assert.IsTrue(file.Credentials.ContainsKey("rfh/nuget"));
        Assert.AreEqual("dev", file.Credentials["rfh/nuget"].Username);
        Assert.AreEqual("plain", file.Credentials["rfh/nuget"].Password);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Credentials_FallBackToThePasswordKey_AndSkipEmptyNodes()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSourceCredentials>
                <private>
                  <add key="Username" value="dev" />
                  <add key="Password" value="encrypted" />
                </private>
                <empty />
              </packageSourceCredentials>
            </configuration>
            """,
            expandEnvironment: true);

        Assert.AreEqual(1, file.Credentials.Count);
        Assert.AreEqual("encrypted", file.Credentials["private"].Password);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Credentials_ExpandEnvironment_WhenTheFileAllowsIt()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSourceCredentials>
                <private>
                  <add key="Username" value="dev" />
                  <add key="ClearTextPassword" value="%NUGET_TOKEN%" />
                </private>
              </packageSourceCredentials>
            </configuration>
            """,
            expandEnvironment: true,
            Variables(("NUGET_TOKEN", "s3cret")));

        Assert.AreEqual("s3cret", file.Credentials["private"].Password);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Credentials_NeverExpandForAWorkspaceFile()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSourceCredentials>
                <private>
                  <add key="Username" value="dev" />
                  <add key="ClearTextPassword" value="%NUGET_TOKEN%" />
                </private>
              </packageSourceCredentials>
            </configuration>
            """,
            expandEnvironment: false,
            Variables(("NUGET_TOKEN", "s3cret")));

        Assert.AreEqual("%NUGET_TOKEN%", file.Credentials["private"].Password);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Mappings_ReadPatternsAndTheClearFlag()
    {
        var file = NuGetConfigParser.Parse(
            """
            <configuration>
              <packageSourceMapping>
                <clear />
                <packageSource key="nuget.org">
                  <package pattern="Newtonsoft.*" />
                  <package pattern="Microsoft.Extensions.*" />
                </packageSource>
                <packageSource key="empty" />
              </packageSourceMapping>
            </configuration>
            """,
            expandEnvironment: true);

        Assert.IsTrue(file.ClearMappings);
        Assert.AreEqual(1, file.Mappings.Count);
        AssertCsv(file.Mappings["nuget.org"], "Newtonsoft.*,Microsoft.Extensions.*");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_MalformedXml_ThrowsXmlException()
    {
        _ = Assert.ThrowsExactly<XmlException>(() => NuGetConfigParser.Parse("<configuration>", expandEnvironment: true));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void DecodeXmlName_DecodesEveryHexQuad()
    {
        Assert.AreEqual("rfh/nuget", NuGetConfigParser.DecodeXmlName("rfh_x002F_nuget"));
        Assert.AreEqual("a b", NuGetConfigParser.DecodeXmlName("a_x0020_b"));
        Assert.AreEqual("plain-name", NuGetConfigParser.DecodeXmlName("plain-name"));
    }
}
