// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/PropertyReferenceTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The writer only translates a value into a property edit when the value is nothing but a
// whole-value reference; every other shape has to stay a literal edit.

using NugetPackageManager.Core.Workspace.Cpm;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
public class PropertyReferenceTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void GetPropertyName_WholeValueReference_ReturnsTheName()
    {
        Assert.AreEqual("FooBarVersion", PropertyReference.GetPropertyName("$(FooBarVersion)"));
        Assert.AreEqual("_Private", PropertyReference.GetPropertyName("$(_Private)"));
        Assert.AreEqual("With-Dash", PropertyReference.GetPropertyName("$(With-Dash)"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetPropertyName_SurroundingWhitespace_IsTolerated()
    {
        Assert.AreEqual("FooBarVersion", PropertyReference.GetPropertyName("  $(FooBarVersion)  "));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetPropertyName_EmbeddedOrMultipleReferences_IsNull()
    {
        Assert.IsNull(PropertyReference.GetPropertyName("1.$(Minor)"));
        Assert.IsNull(PropertyReference.GetPropertyName("$(Major).$(Minor)"));
        Assert.IsNull(PropertyReference.GetPropertyName("13.0.3"));
        Assert.IsNull(PropertyReference.GetPropertyName("$()"));
        Assert.IsNull(PropertyReference.GetPropertyName("$(1Invalid)"));
        Assert.IsNull(PropertyReference.GetPropertyName(string.Empty));
        Assert.IsNull(PropertyReference.GetPropertyName(null));
    }
}
